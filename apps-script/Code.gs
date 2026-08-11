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
var TAB_NAME = 'Form Responses 1';

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
    .addToUi();
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

  console.log('Check-in sync ok: ' + text);
  return text;
}
