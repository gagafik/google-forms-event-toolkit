/**
 * Onboarding.gs — Sidebar entry points and form configuration
 *
 * Functions called from sidebar via google.script.run:
 *   showSidebar()              — opens the sidebar (menu item handler)
 *   getFormQuestions()         — returns MC/CHECKBOX questions for current form
 *   saveSlotConfig(...)        — upsert a slot limit row + register trigger
 *   deleteSlotConfig(...)      — remove a slot limit row
 *   getSlotConfigs()           — returns all configured slots for current form
 *   onAddonUninstall(e)        — cleanup on uninstall (manually triggered; platform has no auto-uninstall hook)
 *   isOnboardingComplete()     — checks onboarding flag in PropertiesService
 *   markOnboardingComplete()   — sets onboarding flag
 *   resetSlotUsed(questionId, optionText) — admin: reset SlotUsed to 0 for active form
 */

// ─── Sidebar ──────────────────────────────────────────────────────────────────

/**
 * Opens the sidebar. Called from the add-on menu.
 */
function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Form Event Toolkit')
    .setWidth(320);
  FormApp.getUi().showSidebar(html);
}

// ─── Form introspection ───────────────────────────────────────────────────────

/**
 * Returns all MULTIPLE_CHOICE and CHECKBOX questions from the current form.
 * Called from sidebar to populate the "Add slot" question dropdown.
 *
 * Returns: [{ id, title, type, options: [string] }, ...]
 */
function getFormQuestions() {
  var form  = FormApp.getActiveForm();
  var items = form.getItems();
  var result = [];

  items.forEach(function(item) {
    var type = item.getType();
    if (type !== FormApp.ItemType.MULTIPLE_CHOICE &&
        type !== FormApp.ItemType.CHECKBOX) return;

    var options = [];
    if (type === FormApp.ItemType.MULTIPLE_CHOICE) {
      options = item.asMultipleChoiceItem().getChoices().map(function(c) { return c.getValue(); });
    } else {
      options = item.asCheckboxItem().getChoices().map(function(c) { return c.getValue(); });
    }

    result.push({
      id:      String(item.getId()),
      title:   item.getTitle(),
      type:    type === FormApp.ItemType.MULTIPLE_CHOICE ? 'MC' : 'CB',
      options: options
    });
  });

  return result;
}

// ─── Slot configuration ───────────────────────────────────────────────────────

/**
 * Returns all configured slot rows for the current form.
 * Called from sidebar to render the main config view.
 *
 * Returns: [{ questionId, optionText, slotLimit, slotUsed, removed, adminEmail }, ...]
 */
function getSlotConfigs() {
  var form   = FormApp.getActiveForm();
  var formId = form.getId();
  var ss     = _getOrCreateSpreadsheet();
  var sheet  = _getOrCreateConfigSheet(ss, formId);
  var rows   = _readConfigRows(sheet, formId);

  return rows.map(function(r) {
    return {
      questionId: r.questionId,
      optionText: r.optionText,
      slotLimit:  r.slotLimit,
      slotUsed:   r.slotUsed,
      removed:    r.removed,
      adminEmail: r.adminEmail
    };
  });
}

/**
 * Upserts a slot limit row in FormConfig.
 * Search key: (FormId, QuestionId, OptionText) — prevents duplicate rows.
 * Registers a per-form onFormSubmit trigger if not already registered.
 *
 * Also enforces freemium limit: only 1 form/month on free tier.
 *
 * Returns: { success: true } | { success: false, error: string, upgradeRequired: bool }
 */
function saveSlotConfig(questionId, optionText, slotLimit, adminEmail) {
  try {
    var form   = FormApp.getActiveForm();
    var formId = form.getId();

    // Validate inputs
    if (!questionId || !optionText) {
      return { success: false, error: 'Question and option are required.', upgradeRequired: false };
    }
    var limit = parseInt(slotLimit, 10);
    if (isNaN(limit) || limit < 1) {
      return { success: false, error: 'Slot limit must be a positive number.', upgradeRequired: false };
    }

    // Freemium check: does this form already have a config row?
    var ss    = _getOrCreateSpreadsheet();
    var sheet = _getOrCreateConfigSheet(ss, formId);
    var existing = _readConfigRows(sheet, formId);
    var isNewForm = existing.length === 0;

    if (isNewForm) {
      var freemiumCheck = checkFreemiumLimit(formId);
      if (!freemiumCheck.allowed) {
        return {
          success:         false,
          error:           'Free tier allows ' + FREEMIUM_FORM_LIMIT + ' form per month. Upgrade to add unlimited forms.',
          upgradeRequired: true
        };
      }
    }

    // Upsert: find existing row by composite key
    var existingIdx = -1;
    existing.forEach(function(row, i) {
      if (row.questionId === String(questionId) &&
          row.optionText === String(optionText)) {
        existingIdx = i;
      }
    });

    if (existingIdx !== -1) {
      // Update existing row
      var row = existing[existingIdx];
      row.slotLimit  = limit;
      row.adminEmail = adminEmail || '';
      // Preserve slotUsed, removed, alert flags
      sheet.getRange(row._sheetRow, 1, 1, 10).setValues([[
        row.formId, row.questionId, row.optionText,
        row.slotLimit, row.slotUsed, row.removed,
        row.alert75, row.alert90, row.alert100, row.adminEmail
      ]]);
    } else {
      // Insert new row
      sheet.appendRow([
        formId, String(questionId), String(optionText),
        limit, 0, false,
        false, false, false, adminEmail || ''
      ]);
    }

    // Register trigger (idempotent via dedup guard)
    _ensureFormSubmitTrigger(formId);

    // Record freemium usage (idempotent)
    if (isNewForm) {
      incrementFreemiumCounter(formId);
    }

    return { success: true };

  } catch (err) {
    return { success: false, error: String(err), upgradeRequired: false };
  }
}

/**
 * Removes a single slot config row (by questionId + optionText).
 * Does NOT remove the trigger — other slots on the form may still be active.
 *
 * Returns: { success: true } | { success: false, error: string }
 */
function deleteSlotConfig(questionId, optionText) {
  try {
    var form   = FormApp.getActiveForm();
    var formId = form.getId();
    var ss     = _getOrCreateSpreadsheet();
    var sheet  = _getOrCreateConfigSheet(ss, formId);
    var rows   = _readConfigRows(sheet, formId);

    var targetRow = null;
    rows.forEach(function(row) {
      if (row.questionId === String(questionId) &&
          row.optionText === String(optionText)) {
        targetRow = row;
      }
    });

    if (!targetRow) {
      return { success: false, error: 'Config row not found.' };
    }

    sheet.deleteRow(targetRow._sheetRow);

    // If no slots remain for this form, remove the now-unnecessary trigger
    var remaining = _readConfigRows(sheet, formId);
    if (remaining.length === 0) {
      _removeFormSubmitTrigger(formId);
    }

    return { success: true };

  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Resets SlotUsed to 0 for a specific row (admin action, e.g. re-running an event).
 * Also resets Removed=false and all AlertXxxSent=false.
 *
 * Returns: { success: true } | { success: false, error: string }
 */
function resetSlotUsed(questionId, optionText) {
  try {
    var form   = FormApp.getActiveForm();
    var formId = form.getId();
    var ss     = _getOrCreateSpreadsheet();
    var sheet  = _getOrCreateConfigSheet(ss, formId);
    var rows   = _readConfigRows(sheet, formId);

    var targetRow = null;
    rows.forEach(function(row) {
      if (row.questionId === String(questionId) &&
          row.optionText === String(optionText)) {
        targetRow = row;
      }
    });

    if (!targetRow) {
      return { success: false, error: 'Config row not found.' };
    }

    sheet.getRange(targetRow._sheetRow, 1, 1, 10).setValues([[
      targetRow.formId, targetRow.questionId, targetRow.optionText,
      targetRow.slotLimit, 0, false,
      false, false, false, targetRow.adminEmail
    ]]);

    return { success: true };

  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ─── Trigger management ───────────────────────────────────────────────────────

/**
 * Registers an onFormSubmit trigger for the given formId if one doesn't exist.
 * Dedup guard: checks PropertiesService before calling ScriptApp.newTrigger().
 * Without this guard, calling saveSlotConfig multiple times would create
 * duplicate triggers → each submission decrements the slot N times.
 */
function _ensureFormSubmitTrigger(formId) {
  var props   = PropertiesService.getUserProperties();
  var propKey = 'trigger_' + formId;

  // Check stored trigger ID
  var storedTriggerId = props.getProperty(propKey);
  if (storedTriggerId) {
    // Verify trigger still exists (user may have deleted it manually)
    var triggers = ScriptApp.getUserTriggers(FormApp.openById(formId));
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getUniqueId() === storedTriggerId) {
        return; // Trigger exists — nothing to do
      }
    }
    // Stored ID is stale — fall through to create a new trigger
  }

  // Create the trigger
  var trigger = ScriptApp.newTrigger('onFormSubmit')
    .forForm(FormApp.openById(formId))
    .onFormSubmit()
    .create();

  props.setProperty(propKey, trigger.getUniqueId());
}

/**
 * Removes the onFormSubmit trigger for the given formId.
 * Called when all slot configs for a form are deleted, or on uninstall.
 */
function _removeFormSubmitTrigger(formId) {
  var props   = PropertiesService.getUserProperties();
  var propKey = 'trigger_' + formId;

  var storedTriggerId = props.getProperty(propKey);
  if (!storedTriggerId) return;

  try {
    var form     = FormApp.openById(formId);
    var triggers = ScriptApp.getUserTriggers(form);
    triggers.forEach(function(t) {
      if (t.getUniqueId() === storedTriggerId) {
        ScriptApp.deleteTrigger(t);
      }
    });
  } catch (_ignore) {}

  props.deleteProperty(propKey);
}

// ─── Onboarding state ─────────────────────────────────────────────────────────

/**
 * Returns true if the user has completed the initial onboarding wizard.
 * Called from sidebar on load to decide whether to show wizard overlay.
 */
function isOnboardingComplete() {
  return PropertiesService.getUserProperties().getProperty('onboardingComplete') === 'true';
}

/**
 * Marks onboarding as complete. Called from sidebar after wizard step 3.
 */
function markOnboardingComplete() {
  PropertiesService.getUserProperties().setProperty('onboardingComplete', 'true');
}

// ─── Add-on lifecycle ─────────────────────────────────────────────────────────

/**
 * Called by the platform when the user uninstalls the add-on.
 * Cleans up all triggers created by this add-on.
 */
function onAddonUninstall(e) {
  // NOTE: Google Workspace Add-ons have no automatic uninstall callback.
  // This function must be wired as a simple trigger or called manually from the sidebar.
  // Installable triggers created by _ensureFormSubmitTrigger() will be cleaned up here.

  // Delete all project triggers (covers all per-form onFormSubmit triggers)
  try {
    var allTriggers = ScriptApp.getProjectTriggers();
    allTriggers.forEach(function(t) {
      try { ScriptApp.deleteTrigger(t); } catch (_ignore) {}
    });
  } catch (_ignore) {}

  // Clear all stored properties (license, freemium counters, trigger IDs, onboarding flag)
  try {
    PropertiesService.getUserProperties().deleteAllProperties();
  } catch (_ignore) {}
}
