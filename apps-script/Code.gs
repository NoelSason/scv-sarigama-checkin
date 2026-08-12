/**
 * SCV Sarigama Onam check-in — payments sheet sync.
 *
 * Paste this into the OnamPayments sheet: Extensions → Apps Script.
 * Then run setUp() once, and installTrigger() once.
 *
 * What it does: every few minutes (and on edit), it sends the "Form Responses 1"
 * grid to the check-in app. The app decides what any of it means — this script
 * is deliberately a dumb pipe, so nobody has to keep two copies of the rules in
 * sync when a column moves.
 *
 * Safe to run as often as you like. Rows that haven't changed do nothing.
 * A row that was edited in a way we can't match confidently becomes a review
 * item in the admin dashboard rather than a duplicate household.
 */

var ENDPOINT = 'https://checkin.scvsarigama.com/api/sync/sheet-push';
var WALKINS_ENDPOINT = 'https://checkin.scvsarigama.com/api/sync/walkins';
var CONTACTS_ENDPOINT = 'https://checkin.scvsarigama.com/api/sync/contacts';
var TAB_NAME = 'Form Responses 1';

/**
 * The contacts tab. Its own sheet, never the payments ledger: the ledger holds
 * Zelle rows only, so the addresses we already have — every card buyer — would
 * have nowhere to sit, and the importer resolves ledger columns by matching
 * header text, so a new column there can quietly capture a field it needs.
 */
var CONTACTS_TAB = 'Pass Contacts';

/**
 * Run this ONCE and paste the secret when prompted.
 * Stored in script properties, not in this file, so the secret never lives in
 * anything that gets shared or version-controlled.
 */
function setUp() {
  var secret = Browser.inputBox(
    'Check-in sync setup',
    'Paste the CRON_SECRET from the check-in app:',
    Browser.Buttons.OK_CANCEL
  );
  if (secret === 'cancel' || !secret) return;
  PropertiesService.getScriptProperties().setProperty('CHECKIN_SECRET', secret.trim());
  Browser.msgBox('Saved. Now run installTrigger() once.');
}

/** Run this ONCE. Sets up a 5-minute timer plus an on-edit trigger. */
function installTrigger() {
  var ss = SpreadsheetApp.getActive();

  // Clear any previous triggers so running this twice doesn't double up.
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncNow' || t.getHandlerFunction() === 'onSheetEdit') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();

  Browser.msgBox('Sync installed. Edits now reach the check-in app within a few minutes.');
}

/** Menu item, so anyone can force a sync without opening the script editor. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Check-in')
    .addItem('Sync now', 'syncNowWithAlert')
    .addSeparator()
    .addItem('Refresh contacts tab', 'refreshContacts')
    .addItem('Send filled-in emails to app', 'pushContacts')
    .addToUi();
}

// ---------------------------------------------------------------------------
// Contacts tab
//
// Two buttons, one loop: refresh pulls everyone the app knows about into a
// tab, a human types the missing addresses, push sends them back.
// ---------------------------------------------------------------------------

/**
 * Rebuild the contacts tab from the app.
 *
 * Anything typed in the Email column is carried across the rebuild — the whole
 * point of the tab is addresses a human entered, and losing them to a refresh
 * would be the one unforgivable bug here. Rows are matched on REF, not on
 * position, so a re-sorted or re-grouped tab still keeps its typing.
 */
function refreshContacts() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('CHECKIN_SECRET');
  if (!secret) {
    Browser.msgBox('Not set up — run setUp() first.');
    return;
  }

  var res = UrlFetchApp.fetch(CONTACTS_ENDPOINT, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    Browser.msgBox('Could not load contacts.\n\n' + describeFailure(res));
    return;
  }

  var data = JSON.parse(res.getContentText());
  var values = data.values;
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(CONTACTS_TAB);

  // Preserve anything already typed, keyed by REF.
  var typed = {};
  if (sheet && sheet.getLastRow() > 1) {
    var old = sheet.getDataRange().getDisplayValues();
    var oldHeader = old[0];
    var oldEmail = indexOfHeader(oldHeader, 'Email');
    var oldRef = indexOfHeaderPrefix(oldHeader, 'REF');
    if (oldEmail > -1 && oldRef > -1) {
      for (var r = 1; r < old.length; r++) {
        var ref = String(old[r][oldRef] || '').trim();
        var addr = String(old[r][oldEmail] || '').trim();
        if (ref && addr) typed[ref] = addr;
      }
    }
  }

  var emailCol = indexOfHeader(values[0], 'Email');
  var refCol = indexOfHeaderPrefix(values[0], 'REF');
  var restored = 0;
  for (var i = 1; i < values.length; i++) {
    var key = String(values[i][refCol] || '').trim();
    if (!values[i][emailCol] && typed[key]) {
      values[i][emailCol] = typed[key];
      restored++;
    }
  }

  if (!sheet) sheet = ss.insertSheet(CONTACTS_TAB);
  sheet.clear();
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);

  formatContacts(sheet, values.length, values[0].length, emailCol, refCol);

  Browser.msgBox(
    'Contacts refreshed.\n\n' +
      data.stats.people + ' people (' + data.stats.households + ' purchases)\n' +
      data.stats.missingEmail + ' still need an email\n' +
      data.stats.duplicateGroups + ' bought more than once\n' +
      (restored ? restored + ' typed-in addresses carried over\n' : '') +
      '\nFill the yellow Email cells, then: Check-in → Send filled-in emails to app.'
  );
}

/** Header row frozen, email column highlighted, REF pushed out of the way. */
function formatContacts(sheet, rows, cols, emailCol, refCol) {
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, cols).setFontWeight('bold').setBackground('#124a33').setFontColor('#ffffff');

  if (rows > 1 && emailCol > -1) {
    var emailRange = sheet.getRange(2, emailCol + 1, rows - 1, 1);
    emailRange.setBackground('#FFF6DF');
    // Only the blanks are the job; a filled cell is not asking for attention.
    var blanks = SpreadsheetApp.newConditionalFormatRule()
      .whenCellEmpty()
      .setBackground('#FDE9A9')
      .setRanges([emailRange])
      .build();
    sheet.setConditionalFormatRules([blanks]);
  }

  for (var c = 1; c <= cols; c++) sheet.autoResizeColumn(c);
  if (refCol > -1) {
    // Long uuid lists; keep them narrow and greyed so nobody feels invited to
    // edit the one column that must survive untouched.
    sheet.setColumnWidth(refCol + 1, 90);
    if (rows > 1) sheet.getRange(2, refCol + 1, rows - 1, 1).setFontColor('#b0aca0');
  }
}

/** Send the filled-in addresses back to the app. */
function pushContacts() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('CHECKIN_SECRET');
  if (!secret) {
    Browser.msgBox('Not set up — run setUp() first.');
    return;
  }

  var sheet = SpreadsheetApp.getActive().getSheetByName(CONTACTS_TAB);
  if (!sheet) {
    Browser.msgBox('No "' + CONTACTS_TAB + '" tab yet — run "Refresh contacts tab" first.');
    return;
  }

  var values = sheet.getDataRange().getDisplayValues();
  var res = UrlFetchApp.fetch(CONTACTS_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify({ values: values, commit: true }),
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    Browser.msgBox('Could not send emails.\n\n' + describeFailure(res));
    return;
  }

  var out = JSON.parse(res.getContentText());
  var message = out.filled + ' email(s) saved.\n' + out.unchanged + ' already on file.';
  if (out.invalid && out.invalid.length) {
    message += '\n\nNot an email address (' + out.invalid.length + '):';
    for (var i = 0; i < Math.min(out.invalid.length, 5); i++) {
      message += '\n  ' + out.invalid[i].name + ': ' + out.invalid[i].offered;
    }
  }
  if (out.corrected && out.corrected.length) {
    message += '\n\nCorrected (' + out.corrected.length + '):';
    for (var j = 0; j < Math.min(out.corrected.length, 5); j++) {
      message += '\n  ' + out.corrected[j].name + ': ' + out.corrected[j].from + ' -> ' + out.corrected[j].to;
    }
  }
  Browser.msgBox(message);
}

/**
 * Turn a failed response into one line a human can act on.
 *
 * The app answers 404 with a full HTML page, and printing that verbatim buries
 * the one fact that matters — which is almost always "this version isn't
 * deployed yet" — under six kilobytes of markup.
 */
function describeFailure(res) {
  var code = res.getResponseCode();
  var body = String(res.getContentText() || '');

  if (code === 404) {
    return (
      'The app answered 404 — this endpoint is not deployed yet.\n' +
      'Deploy the check-in app, then try again.'
    );
  }
  if (code === 401) {
    return 'Rejected the secret (401). Re-run setUp() and paste the current CRON_SECRET.';
  }
  if (code === 503) {
    return 'The app has no CRON_SECRET configured (503). Set it in the hosting dashboard.';
  }

  // Anything else: show a short excerpt, and only if it isn't an HTML page.
  if (body.indexOf('<!DOCTYPE') === 0 || body.indexOf('<html') === 0) {
    return 'HTTP ' + code + ' — the app returned a web page instead of data.';
  }
  return 'HTTP ' + code + ' — ' + body.substring(0, 300);
}

function indexOfHeader(header, name) {
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim().toLowerCase() === name.toLowerCase()) return i;
  }
  return -1;
}

function indexOfHeaderPrefix(header, prefix) {
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim().toUpperCase().indexOf(prefix.toUpperCase()) === 0) return i;
  }
  return -1;
}

/**
 * Edits fire in bursts while someone types. Rather than posting on every
 * keystroke, note that something changed and let the 5-minute timer carry it —
 * except for a payment-mode change, which is the edit that actually issues a
 * pass, so that one goes immediately.
 */
function onSheetEdit(e) {
  if (!e || !e.range) return;
  if (e.range.getSheet().getName() !== TAB_NAME) return;
  syncNow();
}

function syncNowWithAlert() {
  var result = syncNow();
  Browser.msgBox('Sync result: ' + result);
}

function syncNow() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('CHECKIN_SECRET');
  if (!secret) return 'Not set up — run setUp() first.';

  var sheet = SpreadsheetApp.getActive().getSheetByName(TAB_NAME);
  if (!sheet) return 'Tab "' + TAB_NAME + '" not found.';

  // getDisplayValues, not getValues: the app parses text, and display values
  // are what a human sees. Raw values would hand us Date objects and floats
  // that stringify differently and churn the row fingerprints for no reason.
  var values = sheet.getDataRange().getDisplayValues();

  var payload = { values: values, commit: true };

  var response = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });

  var code = response.getResponseCode();
  var text = response.getContentText();

  if (code !== 200) {
    console.error('Check-in sync failed: ' + code + ' ' + text);
    return 'FAILED (' + code + ') ' + text;
  }

  // Sheet → app is only half of it. Walk-ins are created at the desk, and the
  // organizers' record of who paid is this sheet, so they have to come back.
  var appended = pullWalkIns(secret);

  console.log('Check-in sync ok: ' + text + ' | ' + appended);
  return text + ' | ' + appended;
}

/**
 * Append any walk-ins the app has taken that aren't in the sheet yet.
 *
 * Their Payment Mode is written as e.g. "Cash (app)". That marker is why these
 * rows don't come back around and create the same family a second time — the
 * importer recognises them as already-owned and skips them without flagging.
 *
 * Rows are only marked as written after the append succeeds, so a failure
 * mid-way just means the next run tries again rather than losing anyone.
 */
function pullWalkIns(secret) {
  var res = UrlFetchApp.fetch(WALKINS_ENDPOINT, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    console.error('walk-in fetch failed: ' + res.getContentText());
    return 'walk-ins: fetch failed';
  }

  var data = JSON.parse(res.getContentText());
  if (!data.values || data.values.length === 0) return 'walk-ins: none';

  var sheet = SpreadsheetApp.getActive().getSheetByName(TAB_NAME);

  // Insert above the trailing "Total" row rather than after it, so the sheet's
  // own sum keeps covering every row.
  var lastRow = sheet.getLastRow();
  var totalRowIndex = findTotalRow(sheet, lastRow);
  var startRow = totalRowIndex > 0 ? totalRowIndex : lastRow + 1;

  if (totalRowIndex > 0) sheet.insertRowsBefore(totalRowIndex, data.values.length);

  sheet
    .getRange(startRow, 1, data.values.length, data.values[0].length)
    .setValues(data.values);
  SpreadsheetApp.flush();

  var confirm = UrlFetchApp.fetch(WALKINS_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify({ ids: data.ids }),
    muteHttpExceptions: true,
  });

  if (confirm.getResponseCode() !== 200) {
    // The rows are in the sheet but unconfirmed, so the next run would append
    // them again. Say so loudly rather than leaving a silent duplicate.
    console.error('walk-ins appended but NOT confirmed — check for duplicates');
    return 'walk-ins: ' + data.values.length + ' appended, CONFIRM FAILED';
  }

  return 'walk-ins: ' + data.values.length + ' appended';
}

/** The sheet ends with a `Total` row; returns its index, or 0 if absent. */
function findTotalRow(sheet, lastRow) {
  if (lastRow < 2) return 0;
  var names = sheet.getRange(1, 2, lastRow, 1).getDisplayValues();
  for (var i = names.length - 1; i >= 0; i--) {
    if (String(names[i][0]).trim().toLowerCase() === 'total') return i + 1;
  }
  return 0;
}
