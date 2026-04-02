/**
 * Alerts.gs — Threshold-based admin email alerts
 *
 * Sends one email per threshold per option, tracked via boolean columns
 * in FormConfig (Alert75Sent, Alert90Sent, Alert100Sent).
 * All alert operations fail silently — never allowed to affect slot counts.
 *
 * Called from Code.gs after lock release:
 *   sendAlertIfNeeded(configRow, configSheet)
 */

// ─── Constants ────────────────────────────────────────────────────────────────

var ALERT_THRESHOLDS = [
  { pct: 75,  col: 'alert75',  colIdx: 6 },
  { pct: 90,  col: 'alert90',  colIdx: 7 },
  { pct: 100, col: 'alert100', colIdx: 8 }
];

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Checks fill percentage for a single config row and sends any unsent alerts.
 * Updates the AlertXxxSent columns in the sheet when alerts fire.
 *
 * @param {Object} configRow  — plain object from _readConfigRows (has _sheetRow)
 * @param {Sheet}  configSheet — the FormConfig_xxx sheet for this form
 */
function sendAlertIfNeeded(configRow, configSheet) {
  try {
    if (!configRow.adminEmail) return;
    if (configRow.slotLimit <= 0) return;

    var fillPct = (configRow.slotUsed / configRow.slotLimit) * 100;

    ALERT_THRESHOLDS.forEach(function(threshold) {
      if (fillPct < threshold.pct) return;          // not yet at threshold
      if (configRow[threshold.col]) return;          // already sent

      var sent = _sendThresholdAlert(configRow, threshold.pct);
      if (sent) {
        configRow[threshold.col] = true;
        // Write the single cell that changed
        try {
          configSheet.getRange(configRow._sheetRow, threshold.colIdx + 1).setValue(true);
        } catch (_ignore) {}
      }
    });

  } catch (_ignore) {
    // Alert failures are completely silent — do not propagate
  }
}

// ─── Email sender ─────────────────────────────────────────────────────────────

/**
 * Sends a single threshold alert email.
 * Returns true if the email was sent successfully, false otherwise.
 */
function _sendThresholdAlert(row, pct) {
  try {
    var subject = _buildSubject(row, pct);
    var body    = _buildBody(row, pct);
    MailApp.sendEmail(row.adminEmail, subject, body);
    return true;
  } catch (_ignore) {
    return false;
  }
}

function _buildSubject(row, pct) {
  if (pct >= 100) {
    return '[Form Event Toolkit] FULL: "' + row.optionText + '" is now closed';
  }
  return '[Form Event Toolkit] ' + pct + '% full: "' + row.optionText + '"';
}

function _buildBody(row, pct) {
  var lines = [];

  if (pct >= 100) {
    lines.push('The option "' + row.optionText + '" has reached its slot limit and has been automatically removed from your form.');
  } else {
    lines.push('The option "' + row.optionText + '" is ' + pct + '% full.');
  }

  lines.push('');
  lines.push('Details:');
  lines.push('  Option:      ' + row.optionText);
  lines.push('  Slots used:  ' + row.slotUsed + ' / ' + row.slotLimit);
  lines.push('  Form ID:     ' + row.formId);
  lines.push('  Question ID: ' + row.questionId);
  lines.push('');

  if (pct < 100) {
    var remaining = row.slotLimit - row.slotUsed;
    lines.push('  Remaining slots: ' + remaining);
    lines.push('');
  }

  lines.push('— Form Event Toolkit');
  lines.push('  Manage your form: https://docs.google.com/forms/d/' + row.formId + '/edit');

  return lines.join('\n');
}
