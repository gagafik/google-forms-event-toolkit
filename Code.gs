/**
 * Code.gs — Core trigger logic
 *
 * Handles onFormSubmit events: acquires a per-form document lock,
 * batch-reads FormConfig from Sheets, processes slot decrements in
 * memory, batch-writes results, and appends to EventLog.
 *
 * Architecture:
 *
 *   FORM SUBMISSION
 *         │
 *         ▼
 *   onFormSubmit(e)  ← top-level try/catch (never crashes silently)
 *         │
 *         ├── Parse limited choices from submission
 *         │   No limited choices? → EXIT (fast path)
 *         │
 *         ├── getDocumentLock() [scoped to the triggering FORM, not Spreadsheet]
 *         │   │                     [each form gets its own independent lock]
 *         │   ├── ACQUIRED
 *         │   │   ├── Batch read ALL FormConfig rows for this formId (1 API call)
 *         │   │   ├── For each limited choice (in memory):
 *         │   │   │   ├── SlotUsed < SlotLimit  → DECREMENT
 *         │   │   │   ├── SlotUsed >= Limit, Removed=false → REMOVED (Forms API)
 *         │   │   │   │   └── API error → API_ERROR, reset Removed=false
 *         │   │   │   └── Removed=true → ALREADY_FULL (idempotent)
 *         │   │   ├── Batch write changed rows (1 API call)
 *         │   │   ├── Batch append EventLog rows (1 API call)
 *         │   │   └── Release lock
 *         │   └── TIMEOUT → log LOCK_TIMEOUT per choice, fail-open
 *         │
 *         └── Send alert emails AFTER lock release (non-blocking)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

var SPREADSHEET_NAME    = 'FormEventToolkit_Config';
var CONFIG_SHEET_PREFIX = 'FormConfig_';
var EVENTLOG_SHEET      = 'EventLog';
var EVENTLOG_ARCHIVE    = 'EventLog_archive';
var EVENTLOG_MAX_ROWS   = 1000;
var EVENTLOG_ARCHIVE_N  = 500;   // rows to move on each archive run
var LOCK_TIMEOUT_MS     = 10000; // 10 seconds

// Column indices in FormConfig sheet (0-based after header)
var COL = {
  FormId:      0,
  QuestionId:  1,
  OptionText:  2,
  SlotLimit:   3,
  SlotUsed:    4,
  Removed:     5,
  Alert75:     6,
  Alert90:     7,
  Alert100:    8,
  AdminEmail:  9
};

// ─── Main trigger ─────────────────────────────────────────────────────────────

/**
 * Registered per-form via saveSlotConfig() in Onboarding.gs.
 * Top-level catch ensures trigger never crashes silently.
 */
function onFormSubmit(e) {
  try {
    _processSubmission(e);
  } catch (err) {
    // Log unexpected errors to EventLog — never re-throw from a trigger
    try {
      var formId = e && e.source ? e.source.getId() : 'unknown';
      _appendEventLogBatch(_getOrCreateSpreadsheet(), [[
        new Date(), formId, 'UNEXPECTED_ERROR', null, null, null, null, 'N/A',
        String(err)
      ]]);
    } catch (_ignore) {
      console.error('UNEXPECTED_ERROR (EventLog write also failed):', err);
    }
  }
}

function _processSubmission(e) {
  var formId = e.source.getId();
  var ss     = _getOrCreateSpreadsheet();
  var sheet  = _getOrCreateConfigSheet(ss, formId);

  // 1. Fast path: any limited choices configured for this form?
  var configRows = _readConfigRows(sheet, formId);
  if (configRows.length === 0) return;

  // Build optionText → row index map
  var configMap = {};
  configRows.forEach(function(row, idx) { configMap[row.optionText] = idx; });

  // 2. Which submitted choices are limited?
  var limited = _getLimitedChoices(e, configMap);
  if (limited.length === 0) return;

  // 3. Acquire document lock (scoped to the FORM that triggered this event)
  var lock = LockService.getDocumentLock();
  var acquired = lock.tryLock(LOCK_TIMEOUT_MS);

  if (!acquired) {
    // Fail-open: submission accepted by Forms regardless.
    // Log LOCK_TIMEOUT per choice. Slot NOT decremented.
    var timeoutRows = limited.map(function(c) {
      return [new Date(), formId, 'LOCK_TIMEOUT', c.questionId, c.optionText,
              null, null, 'TIMEOUT', ''];
    });
    _appendEventLogBatch(ss, timeoutRows);
    return;
  }

  var logRows = [];
  var changed = {}; // row idx → updated row

  try {
    // 4. Re-read inside lock (fresh state, avoids stale reads)
    var freshRows = _readConfigRows(sheet, formId);
    var freshMap  = {};
    freshRows.forEach(function(row, idx) { freshMap[row.optionText] = idx; });

    // 5. Process each limited choice in memory
    limited.forEach(function(choice) {
      var idx = freshMap[choice.optionText];
      if (idx === undefined) return; // Config deleted mid-event

      var row = freshRows[idx];

      if (row.removed) {
        logRows.push([new Date(), formId, 'ALREADY_FULL',
          choice.questionId, choice.optionText,
          row.slotUsed, row.slotUsed, 'ACQUIRED', '']);
        return;
      }

      if (row.slotUsed < row.slotLimit) {
        // Happy path: decrement
        var before = row.slotUsed;
        row.slotUsed += 1;
        changed[idx] = row;
        logRows.push([new Date(), formId, 'DECREMENT',
          choice.questionId, choice.optionText,
          before, row.slotUsed, 'ACQUIRED', '']);

      } else {
        // Slot exhausted: remove option from form
        // Optimistic dedup: set Removed=true BEFORE API call.
        // If API fails, reset to false so next trigger retries.
        row.removed = true;
        changed[idx] = row;

        try {
          _removeFormOption(formId, choice.questionId, choice.optionText);
          logRows.push([new Date(), formId, 'REMOVED',
            choice.questionId, choice.optionText,
            row.slotUsed, row.slotUsed, 'ACQUIRED', '']);
        } catch (apiErr) {
          // Reset flag — next trigger will retry the API call
          row.removed = false;
          changed[idx] = row;
          logRows.push([new Date(), formId, 'API_ERROR',
            choice.questionId, choice.optionText,
            row.slotUsed, row.slotUsed, 'ACQUIRED', String(apiErr)]);
        }
      }
    });

    // 6. Batch write changed rows (single setValues per changed row)
    if (Object.keys(changed).length > 0) {
      _batchWriteRows(sheet, freshRows, changed);
    }

    // 7. Batch append EventLog
    if (logRows.length > 0) {
      _appendEventLogBatch(ss, logRows);
    }

  } finally {
    lock.releaseLock();
  }

  // 8. Alert emails AFTER lock release — failure must not affect slot counts
  try {
    var postRows = _readConfigRows(sheet, formId);
    var postMap  = {};
    postRows.forEach(function(r) { postMap[r.optionText] = r; });
    limited.forEach(function(choice) {
      var row = postMap[choice.optionText];
      if (row) sendAlertIfNeeded(row, sheet);
    });
  } catch (_ignore) {}
}

// ─── FormConfig helpers ───────────────────────────────────────────────────────

/**
 * Reads all FormConfig rows for a given formId.
 * Returns array of plain objects. Excludes header row.
 */
function _readConfigRows(sheet, formId) {
  var data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];

  return data.slice(1)
    .map(function(row, i) {
      return {
        _sheetRow:  i + 2, // 1-based sheet row (row 1 = header)
        formId:     String(row[COL.FormId]),
        questionId: String(row[COL.QuestionId]),
        optionText: String(row[COL.OptionText]),
        slotLimit:  Number(row[COL.SlotLimit])  || 0,
        slotUsed:   Number(row[COL.SlotUsed])   || 0,
        removed:    _toBool(row[COL.Removed]),
        alert75:    _toBool(row[COL.Alert75]),
        alert90:    _toBool(row[COL.Alert90]),
        alert100:   _toBool(row[COL.Alert100]),
        adminEmail: String(row[COL.AdminEmail] || '')
      };
    })
    .filter(function(row) { return row.formId === formId; });
}

function _toBool(val) {
  return val === true || val === 'TRUE' || val === 'true';
}

/**
 * Batch-write only the rows that changed.
 * One setValues call per changed row to minimise API calls.
 */
function _batchWriteRows(sheet, allRows, changed) {
  Object.keys(changed).forEach(function(idx) {
    var row = changed[idx];
    sheet.getRange(row._sheetRow, 1, 1, 10).setValues([[
      row.formId, row.questionId, row.optionText,
      row.slotLimit, row.slotUsed, row.removed,
      row.alert75, row.alert90, row.alert100, row.adminEmail
    ]]);
  });
}

// ─── Forms API ────────────────────────────────────────────────────────────────

/**
 * Removes an option from a MULTIPLE_CHOICE or CHECKBOX question.
 * Forms API is idempotent: removing an already-removed option is safe.
 */
function _removeFormOption(formId, questionId, optionText) {
  var form  = FormApp.openById(formId);
  var items = form.getItems();

  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (String(item.getId()) !== questionId) continue;

    var type = item.getType();
    if (type === FormApp.ItemType.MULTIPLE_CHOICE) {
      var mc      = item.asMultipleChoiceItem();
      var choices = mc.getChoices().filter(function(c) {
        return c.getValue() !== optionText;
      });
      mc.setChoices(choices);

    } else if (type === FormApp.ItemType.CHECKBOX) {
      var cb       = item.asCheckboxItem();
      var choices2 = cb.getChoices().filter(function(c) {
        return c.getValue() !== optionText;
      });
      cb.setChoices(choices2);

    } else if (type === FormApp.ItemType.LIST) {
      var list     = item.asListItem();
      var choices3 = list.getChoices().filter(function(c) {
        return c.getValue() !== optionText;
      });
      list.setChoices(choices3);
    }
    return;
  }
  throw new Error('Question ' + questionId + ' not found in form ' + formId);
}

// ─── Submission parsing ───────────────────────────────────────────────────────

/**
 * Returns the subset of submitted choices that are configured as limited.
 * Handles both MULTIPLE_CHOICE (string) and CHECKBOX (array) response types.
 */
function _getLimitedChoices(e, configMap) {
  var limited = [];
  try {
    var responses = e.response.getItemResponses();
    responses.forEach(function(ir) {
      var item = ir.getItem();
      var type = item.getType();
      if (type !== FormApp.ItemType.MULTIPLE_CHOICE &&
          type !== FormApp.ItemType.CHECKBOX &&
          type !== FormApp.ItemType.LIST) return;

      var questionId = String(item.getId());
      var answer     = ir.getResponse();
      var options    = Array.isArray(answer) ? answer : [answer];

      options.forEach(function(opt) {
        if (configMap.hasOwnProperty(opt)) {
          limited.push({ questionId: questionId, optionText: opt });
        }
      });
    });
  } catch (_ignore) {}
  return limited;
}

// ─── Spreadsheet / EventLog helpers ──────────────────────────────────────────

/**
 * Returns the shared per-user config Spreadsheet, creating it if needed.
 * The Spreadsheet ID is cached in PropertiesService.
 */
function _getOrCreateSpreadsheet() {
  var props = PropertiesService.getUserProperties();
  var ssId  = props.getProperty('configSpreadsheetId');

  if (ssId) {
    try { return SpreadsheetApp.openById(ssId); } catch (_ignore) {}
  }

  var ss = SpreadsheetApp.create(SPREADSHEET_NAME);
  // Move default 'Sheet1' out of the way
  var defaultSheet = ss.getSheets()[0];
  if (defaultSheet) defaultSheet.setName('_setup');

  props.setProperty('configSpreadsheetId', ss.getId());
  return ss;
}

/**
 * Returns (or creates) the FormConfig tab for a specific formId.
 * Tab name: 'FormConfig_' + first 80 chars of formId.
 */
function _getOrCreateConfigSheet(ss, formId) {
  var name  = CONFIG_SHEET_PREFIX + formId.substring(0, 80);
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow([
      'FormId', 'QuestionId', 'OptionText', 'SlotLimit', 'SlotUsed',
      'Removed', 'Alert75Sent', 'Alert90Sent', 'Alert100Sent', 'AdminEmail'
    ]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/**
 * Appends multiple rows to the EventLog sheet.
 * Archives oldest rows if cap is exceeded.
 *
 * Row format: [Timestamp, FormId, Action, QuestionId, OptionText,
 *              SlotBefore, SlotAfter, LockStatus, Notes]
 */
function _appendEventLogBatch(ss, rows) {
  var sheet = ss.getSheetByName(EVENTLOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(EVENTLOG_SHEET);
    sheet.appendRow([
      'Timestamp', 'FormId', 'Action', 'QuestionId', 'OptionText',
      'SlotBefore', 'SlotAfter', 'LockStatus', 'Notes'
    ]);
    sheet.setFrozenRows(1);
  }

  // Archive oldest rows if over cap
  if (sheet.getLastRow() > EVENTLOG_MAX_ROWS) {
    _archiveEventLog(ss, sheet);
  }

  if (rows.length === 0) return;
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length)
       .setValues(rows);
}

function _archiveEventLog(ss, sheet) {
  try {
    var archive = ss.getSheetByName(EVENTLOG_ARCHIVE);
    if (!archive) {
      archive = ss.insertSheet(EVENTLOG_ARCHIVE);
      archive.appendRow([
        'Timestamp', 'FormId', 'Action', 'QuestionId', 'OptionText',
        'SlotBefore', 'SlotAfter', 'LockStatus', 'Notes'
      ]);
    }
    // Move the oldest EVENTLOG_ARCHIVE_N data rows (row 2 onwards, skip header)
    var toMove = sheet.getRange(2, 1, EVENTLOG_ARCHIVE_N, 9).getValues();
    archive.getRange(archive.getLastRow() + 1, 1, toMove.length, 9).setValues(toMove);
    sheet.deleteRows(2, EVENTLOG_ARCHIVE_N);
  } catch (_ignore) {}
}

// ─── Web app entry point (for screenshot/preview only) ───────────────────────

function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('SlotGuard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─── Add-on entry point ───────────────────────────────────────────────────────

/**
 * Called when the form is opened. Opens the sidebar.
 * Declared here so it's always available; sidebar rendering is in Onboarding.gs.
 */
function onFormOpen(e) {
  return CardService.newCardBuilder()
    .setHeader(CardService.newCardHeader()
      .setTitle('SlotGuard')
      .setSubtitle('Response Limiter for Google Forms'))
    .addSection(CardService.newCardSection()
      .addWidget(CardService.newDecoratedText()
        .setText('Limit responses, cap choices, and auto-close your forms.'))
      .addWidget(CardService.newTextButton()
        .setText('Open SlotGuard')
        .setTextButtonStyle(CardService.TextButtonStyle.FILLED)
        .setOnClickAction(CardService.newAction().setFunctionName('openSidebarFromCard')))
    )
    .build();
}

function openSidebarFromCard(e) {
  showSidebar();
  return CardService.newActionResponseBuilder().build();
}
