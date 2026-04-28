/**
 * Billing.gs — License validation and freemium enforcement
 *
 * Architecture:
 *   - Gumroad for checkout + license key activation
 *   - PropertiesService (UserProperties) for persistence
 *   - Freemium: 1 form/month, resets on calendar month rollover
 *
 * PropertiesService keys:
 *   licenseKey      — raw key entered by user
 *   licenseStatus   — 'active' | 'invalid' | unset
 *   freemium_month  — 'YYYY-MM' of current freemium window
 *   freemium_forms  — JSON array of formIds used this month
 */

// ─── Constants ────────────────────────────────────────────────────────────────

var GUMROAD_CHECKOUT_URL  = 'https://gagafik.gumroad.com/l/slotguard';
var GUMROAD_VALIDATE_URL  = 'https://api.gumroad.com/v2/licenses/verify';
var GUMROAD_PRODUCT_ID    = '-kXpJZmKKqRg_uXznXXebQ==';
var FREEMIUM_FORM_LIMIT   = 1;   // max unique forms per calendar month

// ─── Checkout ─────────────────────────────────────────────────────────────────

/**
 * Returns the Gumroad checkout URL.
 * Called from sidebar: google.script.run.withSuccessHandler(url => window.open(url, '_blank')).getCheckoutUrl()
 */
function getCheckoutUrl() {
  return GUMROAD_CHECKOUT_URL;
}

// ─── License activation ───────────────────────────────────────────────────────

/**
 * Validates a LemonSqueezy license key via HTTP POST.
 * Returns { success: true } or { success: false, error: string }
 *
 * Called from sidebar via google.script.run.
 */
function activateLicense(key) {
  if (!key || typeof key !== 'string') {
    return { success: false, error: 'No key provided.' };
  }

  // Gumroad license key format: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX
  var keyRegex = /^[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}-[0-9A-F]{8}$/i;
  if (!keyRegex.test(key.trim())) {
    return { success: false, error: 'Invalid key format. Keys look like: XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX' };
  }

  try {
    var payload = 'product_id=' + encodeURIComponent(GUMROAD_PRODUCT_ID) +
                  '&license_key=' + encodeURIComponent(key.trim()) +
                  '&increment_uses_count=false';

    var response = UrlFetchApp.fetch(GUMROAD_VALIDATE_URL, {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      payload: payload,
      muteHttpExceptions: true
    });

    var body;
    try {
      body = JSON.parse(response.getContentText());
    } catch (_) {
      return { success: false, error: 'Unexpected response from billing server.' };
    }

    if (body.success) {
      var props = PropertiesService.getUserProperties();
      props.setProperties({
        licenseKey:    key.trim(),
        licenseStatus: 'active'
      });
      return { success: true };
    }

    return { success: false, error: body.message || 'License key not found or invalid.' };

  } catch (err) {
    return { success: false, error: 'Network error: ' + String(err) };
  }
}

/**
 * Returns true if the user has an active paid license.
 */
function isPaidUser() {
  var props  = PropertiesService.getUserProperties();
  return props.getProperty('licenseStatus') === 'active';
}

/**
 * Deactivates the current license (e.g. to allow transfer to a new account).
 * Called from sidebar.
 */
function deactivateLicense() {
  var props = PropertiesService.getUserProperties();
  props.deleteProperty('licenseKey');
  props.deleteProperty('licenseStatus');
  return { success: true };
}

/**
 * Returns current license info for the sidebar UI.
 * Called from sidebar via google.script.run.
 */
function getLicenseInfo() {
  var props  = PropertiesService.getUserProperties();
  var status = props.getProperty('licenseStatus') || 'none';
  var key    = props.getProperty('licenseKey')    || '';
  // Mask key: show last 8 chars only
  var masked = key.length > 8 ? '****-****-****-' + key.slice(-8) : key;
  return { status: status, maskedKey: masked };
}

// ─── Freemium enforcement ─────────────────────────────────────────────────────

/**
 * Checks if adding a new form is within the freemium limit.
 * Performs lazy reset: if stored month !== current month, resets counter.
 *
 * Returns:
 *   { allowed: true,  formsUsed: n, formIds: [...] }  — within limit or already counted
 *   { allowed: false, formsUsed: n, formIds: [...] }  — limit reached
 */
function checkFreemiumLimit(formId) {
  if (isPaidUser()) return { allowed: true, formsUsed: 0, formIds: [] };

  var props       = PropertiesService.getUserProperties();
  var currentMonth = _currentYearMonth();
  var storedMonth  = props.getProperty('freemium_month');

  var formIds = [];
  if (storedMonth === currentMonth) {
    try { formIds = JSON.parse(props.getProperty('freemium_forms') || '[]'); } catch (_) {}
  }
  // Month rolled over → reset (lazy)

  // Already counted this form this month
  if (formId && formIds.indexOf(formId) !== -1) {
    return { allowed: true, formsUsed: formIds.length, formIds: formIds };
  }

  var allowed = formIds.length < FREEMIUM_FORM_LIMIT;
  return { allowed: allowed, formsUsed: formIds.length, formIds: formIds };
}

/**
 * Records a formId as used in the current freemium window.
 * Idempotent: calling twice with the same formId has no effect.
 * Must be called AFTER checkFreemiumLimit returns allowed=true.
 */
function incrementFreemiumCounter(formId) {
  if (isPaidUser()) return;
  if (!formId) return;

  var props        = PropertiesService.getUserProperties();
  var currentMonth = _currentYearMonth();
  var storedMonth  = props.getProperty('freemium_month');

  var formIds = [];
  if (storedMonth === currentMonth) {
    try { formIds = JSON.parse(props.getProperty('freemium_forms') || '[]'); } catch (_) {}
  }
  // Month rolled over → formIds stays [] (lazy reset)

  if (formIds.indexOf(formId) === -1) {
    formIds.push(formId);
  }

  props.setProperties({
    freemium_month: currentMonth,
    freemium_forms: JSON.stringify(formIds)
  });
}

/**
 * Returns current freemium usage summary for sidebar.
 * Called from sidebar via google.script.run.
 */
function getFreemiumStatus() {
  if (isPaidUser()) {
    return { isPaid: true, formsUsed: 0, formsLimit: null, month: _currentYearMonth() };
  }

  var check = checkFreemiumLimit(null);
  return {
    isPaid:     false,
    formsUsed:  check.formsUsed,
    formsLimit: FREEMIUM_FORM_LIMIT,
    month:      _currentYearMonth()
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _currentYearMonth() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
