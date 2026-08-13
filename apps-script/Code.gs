/**
 * SCV Sarigama Onam check-in — payments sheet sync.
 *
 * Paste this into the OnamPayments sheet: Extensions → Apps Script.
 * Then run setUp() once, and installTrigger() once.
 *
 * What it does: every few minutes (and on edit), it sends the "Form Responses 1"
 * grid to the check-in app. The app decides what any of it means — this script
 * is deliberately a dumb pipe, so nobody has to keep two copies of the rules in
 * sync when a column moves. The same run pulls walk-ins back into the ledger
 * and appends paid Stripe orders from pay.scvsarigama.com to their own
 * "Stripe Orders" tab.
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
 * Security audit tab. Append-only: rows already written are never rewritten, so
 * the record cannot be quietly altered by a later sync, and event day's few
 * thousand scans do not mean re-uploading the whole history every five minutes.
 */
var ANALYTICS_TAB = 'Event Analytics';
var ANALYTICS_ENDPOINT = 'https://checkin.scvsarigama.com/api/sync/analytics';

/**
 * Paid orders from the pay.scvsarigama.com storefront. Their own tab, not the
 * ledger: an order carries sponsorships, donations, and the Onam program
 * registration answers, none of which have a column in "Form Responses 1".
 * (The household behind each order still flows into the ledger through the
 * walk-ins pull, so the money total stays complete.)
 */
var STRIPE_ORDERS_TAB = 'Stripe Orders';
var STRIPE_ORDERS_ENDPOINT = 'https://checkin.scvsarigama.com/api/sync/stripe-orders';

/** Must match the column order the endpoint sends — 18 columns. */
var STRIPE_ORDERS_HEADER = [
  'Timestamp', 'Order #', 'Name', 'Email', 'Phone', 'Total $',
  'Adults (6+)', 'Under 6', 'Gold', 'Silver', 'Donation $',
  'Performing?', 'Individual or Group', 'Performer name', 'Members',
  'Performance type', 'Media?', 'Stage/requirements',
];

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
/**
 * Every handler this script installs. Listed in one place because the cleanup
 * below has to match it exactly: a handler that gets created but not cleared
 * ends up with a second copy on the next run, and two `autoContactsSync` timers
 * firing together means two pushes and two refreshes racing on the same tab.
 */
var MANAGED_TRIGGERS = ['syncNow', 'onSheetEdit', 'autoContactsSync', 'pullAnalytics'];

function installTrigger() {
  var ss = SpreadsheetApp.getActive();

  // Safe to run as often as you like: everything we own is cleared first.
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (MANAGED_TRIGGERS.indexOf(t.getHandlerFunction()) > -1) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  ScriptApp.newTrigger('syncNow').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onSheetEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('autoContactsSync').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('pullAnalytics').timeBased().everyMinutes(5).create();

  Browser.msgBox(
    'Sync installed.\n\n' +
      (removed ? 'Replaced ' + removed + ' existing trigger(s).\n\n' : '') +
      'Every 5 minutes, on their own:\n' +
      '  · Form Responses  ->  the app (also instantly on edit)\n' +
      '  · ' + CONTACTS_TAB + '  ->  emails sent, then tab rebuilt\n' +
      '  · ' + ANALYTICS_TAB + '  ->  new events appended\n' +
      '  · ' + STRIPE_ORDERS_TAB + '  ->  new paid orders appended'
  );
}

/** Shows what is actually installed, for when you want to be sure. */
function listTriggers() {
  var lines = ScriptApp.getProjectTriggers().map(function (t) {
    return '  · ' + t.getHandlerFunction();
  });
  Browser.msgBox(
    lines.length ? lines.length + ' trigger(s) installed:\n\n' + lines.join('\n')
                 : 'No triggers installed — run installTrigger().'
  );
}

/**
 * The automatic half of the contacts loop, on a 5-minute timer.
 *
 * Push before refresh, always. Refresh rewrites the Email column from the app,
 * so anything typed but not yet sent would be wiped by a refresh that ran first.
 *
 * No dialogs anywhere in here — a time-based trigger has no user to show them
 * to, and calling Browser.msgBox would abort the run.
 */
function autoContactsSync() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CONTACTS_TAB);
  if (!sheet) return; // tab not built yet; nothing to keep in sync

  var pushed = pushContactsSilent();
  if (!pushed.ok) {
    console.error('auto contacts push failed: ' + pushed.message);
    return; // do NOT refresh — that would discard the typing we failed to send
  }

  var refreshed = refreshContactsSilent();
  if (!refreshed.ok) {
    console.error('auto contacts refresh failed: ' + refreshed.message);
    return;
  }

  if (pushed.saved || pushed.corrected) {
    console.log('auto contacts: ' + pushed.saved + ' saved, ' + pushed.corrected + ' corrected');
  }
}

/** Menu item, so anyone can force a sync without opening the script editor. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Check-in')
    .addItem('Sync now', 'syncNowWithAlert')
    .addSeparator()
    .addItem('Refresh contacts tab', 'refreshContacts')
    .addItem('Send filled-in emails to app', 'pushContacts')
    .addSeparator()
    .addItem('Update event analytics', 'refreshAnalytics')
    .addSeparator()
    .addItem('Show installed triggers', 'listTriggers')
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
  var result = refreshContactsSilent();
  Browser.msgBox(result.message);
}

/**
 * The same work with no dialogs.
 *
 * Browser.msgBox only exists when a human has the sheet open; calling it from a
 * time-based trigger throws and the whole run dies. Every automatic path goes
 * through here, and only the menu items talk to the user.
 */
function refreshContactsSilent() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('CHECKIN_SECRET');
  if (!secret) return { ok: false, message: 'Not set up — run setUp() first.' };

  var res = UrlFetchApp.fetch(CONTACTS_ENDPOINT, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    return { ok: false, message: 'Could not load contacts.\n\n' + describeFailure(res) };
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

  return {
    ok: true,
    stats: data.stats,
    message:
      'Contacts refreshed.\n\n' +
      data.stats.people + ' people (' + data.stats.households + ' purchases)\n' +
      data.stats.missingEmail + ' still need an email\n' +
      data.stats.duplicateGroups + ' bought more than once\n' +
      (restored ? restored + ' typed-in addresses carried over\n' : '') +
      '\nFill the yellow Email cells — they send to the app on their own within 5 minutes.',
  };
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
  var result = pushContactsSilent();
  Browser.msgBox(result.message);
}

/** Dialog-free, so the 5-minute trigger can call it. */
function pushContactsSilent() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('CHECKIN_SECRET');
  if (!secret) return { ok: false, message: 'Not set up — run setUp() first.' };

  var sheet = SpreadsheetApp.getActive().getSheetByName(CONTACTS_TAB);
  if (!sheet) {
    return { ok: false, message: 'No "' + CONTACTS_TAB + '" tab yet — refresh it first.' };
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
    return { ok: false, message: 'Could not send emails.\n\n' + describeFailure(res) };
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
  return { ok: true, saved: out.filled, corrected: (out.corrected || []).length, message: message };
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

// ---------------------------------------------------------------------------
// Event Analytics
//
// Every recorded action in the app: payments, logins (with address and rough
// location), scans, desk lookups, admin changes, raffle draws, syncs, emails.
// ---------------------------------------------------------------------------

/** Menu version: reports what it did. */
function refreshAnalytics() {
  var added = pullAnalytics();
  Browser.msgBox(
    added < 0
      ? 'Could not update event analytics — see the execution log.'
      : added + ' new event(s) added to "' + ANALYTICS_TAB + '".'
  );
}

/**
 * Fetch everything that has happened since last time and append it.
 *
 * Returns the number of rows added, or -1 on failure. No dialogs: this runs on
 * a timer, where there is nobody to show one to.
 */
function pullAnalytics() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('CHECKIN_SECRET');
  if (!secret) return -1;

  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(ANALYTICS_TAB);
  var cursor = props.getProperty('ANALYTICS_CURSOR') || '';

  // Ids already on the sheet. The endpoint deliberately re-sends a short overlap
  // so an event sharing a timestamp with the cursor cannot slip through the gap;
  // this is what makes that overlap harmless.
  var seen = {};
  if (sheet && sheet.getLastRow() > 1) {
    var idCol = sheet.getLastColumn();
    var existing = sheet.getRange(2, idCol, sheet.getLastRow() - 1, 1).getDisplayValues();
    for (var e = 0; e < existing.length; e++) seen[existing[e][0]] = true;
  }

  var total = 0;
  // Drain the backlog rather than adding one page per tick, so a busy event day
  // catches up in one run instead of falling further behind.
  for (var page = 0; page < 20; page++) {
    var url = ANALYTICS_ENDPOINT + (cursor ? '?since=' + encodeURIComponent(cursor) : '');
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + secret },
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) {
      console.error('analytics fetch failed: ' + describeFailure(res));
      return total > 0 ? total : -1;
    }

    var data = JSON.parse(res.getContentText());

    if (!sheet) {
      sheet = ss.insertSheet(ANALYTICS_TAB);
      sheet.getRange(1, 1, 1, data.headers.length).setValues([data.headers]);
      sheet.setFrozenRows(1);
      sheet.getRange(1, 1, 1, data.headers.length)
        .setFontWeight('bold').setBackground('#124a33').setFontColor('#ffffff');
      sheet.setColumnWidth(data.headers.length, 60); // event id: present, not prominent
    } else if (page === 0) {
      // The tab was created before the feed moved to Pacific time; bring its
      // header — and the timestamps written under the old one — into line.
      convertAnalyticsToPacific_(sheet, data.headers);
    }

    var fresh = [];
    for (var i = 0; i < data.values.length; i++) {
      var id = data.values[i][data.values[i].length - 1];
      if (!seen[id]) { seen[id] = true; fresh.push(data.values[i]); }
    }

    if (fresh.length) {
      sheet.getRange(sheet.getLastRow() + 1, 1, fresh.length, fresh[0].length).setValues(fresh);
      total += fresh.length;
    }

    if (data.cursor) { cursor = data.cursor; props.setProperty('ANALYTICS_CURSOR', cursor); }
    if (!data.more) break;
  }

  if (total) {
    SpreadsheetApp.flush();
    console.log('analytics: ' + total + ' new event(s)');
  }
  return total;
}

/**
 * The analytics tab used to record UTC. Everyone reading it is in California, so
 * the column now holds Pacific time — which means the rows written under the old
 * heading have to be shifted too, or the tab would mix two clocks under one
 * label. Recognising the old heading is the whole trigger: once it is gone the
 * work is done, so this costs one string compare per run afterwards.
 */
/** California's distance from UTC around a given moment, in milliseconds. */
function pacificOffsetMs_(when) {
  var z = Utilities.formatDate(when, 'America/Los_Angeles', 'Z'); // e.g. "-0700"
  var sign = z.charAt(0) === '-' ? -1 : 1;
  var hours = parseInt(z.substr(1, 2), 10);
  var minutes = parseInt(z.substr(3, 2), 10);
  return sign * (hours * 60 + minutes) * 60 * 1000;
}

function convertAnalyticsToPacific_(sheet, headers) {
  if (String(sheet.getRange(1, 1).getValue()).indexOf('UTC') === -1) return;

  var last = sheet.getLastRow();
  if (last > 1) {
    var when = sheet.getRange(2, 1, last - 1, 1);
    var stamps = when.getValues();
    for (var i = 0; i < stamps.length; i++) {
      var cell = stamps[i][0];
      if (cell instanceof Date) {
        // Sheets parsed the feed's text into a real date, so the fix is to move
        // the instant back by California's offset at that moment; what the cell
        // shows moves with it.
        stamps[i][0] = new Date(cell.getTime() + pacificOffsetMs_(cell));
        continue;
      }
      var raw = String(cell).trim();
      // Only the exact shape the feed writes; anything else is left alone
      // rather than guessed at.
      if (!/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}$/.test(raw)) continue;
      var utc = new Date(raw.replace(' ', 'T') + 'Z');
      if (isNaN(utc.getTime())) continue;
      stamps[i][0] = Utilities.formatDate(utc, 'America/Los_Angeles', 'yyyy-MM-dd HH:mm:ss');
    }
    when.setValues(stamps);
  }

  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  console.log('analytics: converted ' + Math.max(last - 1, 0) + ' row(s) to Pacific time');
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

  // Same reason, different tab: storefront orders exist only in the app until
  // this pulls them over.
  var orders = pullStripeOrders(secret);

  console.log('Check-in sync ok: ' + text + ' | ' + appended + ' | ' + orders);
  return text + ' | ' + appended + ' | ' + orders;
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

  // Write into the next free row, which is not the same as the next row.
  //
  // The sheet carries a block of leftover template rows between the last real
  // entry and the Total — no name, no amount, but drag-filled checkboxes. Those
  // are the rows a person would use next, so they are the rows we use. Appending
  // after the last name instead left every card sale stranded below that gap,
  // far from the entries anyone is actually reading, and the gap never closed.
  //
  // New rows are only inserted once the gap is full, and always above Total, so
  // the sheet's own sum keeps covering everything.
  var lastRow = sheet.getLastRow();
  var totalRow = findTotalRow(sheet, lastRow);

  // The first row we are not allowed to overwrite: the Total, or the end of the
  // sheet if somebody has removed it.
  var floorRow = totalRow > 0 ? totalRow : lastRow + 1;

  var startRow = findFirstFreeRow(sheet, floorRow);
  var free = countFreeRowsFrom(sheet, startRow, floorRow);
  var needed = data.values.length;

  // Only what the gap cannot absorb. Inserting right where the free rows run
  // out keeps the whole batch contiguous, so it still writes in one go.
  if (needed > free) sheet.insertRowsBefore(startRow + free, needed - free);

  sheet.getRange(startRow, 1, needed, data.values[0].length).setValues(data.values);
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

/**
 * Append paid storefront orders from pay.scvsarigama.com to their own tab.
 *
 * Same fetch-append-confirm shape as pullWalkIns: rows are only marked
 * exported after the append lands in the sheet, so a failure mid-way means
 * the next run retries instead of losing an order. Unlike the ledger, this
 * tab is append-only — each order arrives exactly once, so a plain append at
 * the bottom is all it takes.
 */
function pullStripeOrders(secret) {
  var res = UrlFetchApp.fetch(STRIPE_ORDERS_ENDPOINT, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + secret },
    muteHttpExceptions: true,
  });

  if (res.getResponseCode() !== 200) {
    console.error('stripe orders fetch failed: ' + describeFailure(res));
    return 'orders: fetch failed';
  }

  var data = JSON.parse(res.getContentText());
  if (!data.values || data.values.length === 0) return 'orders: none';

  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(STRIPE_ORDERS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(STRIPE_ORDERS_TAB);
    sheet.getRange(1, 1, 1, STRIPE_ORDERS_HEADER.length).setValues([STRIPE_ORDERS_HEADER]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, STRIPE_ORDERS_HEADER.length)
      .setFontWeight('bold').setBackground('#124a33').setFontColor('#ffffff');
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, data.values.length, data.values[0].length)
    .setValues(data.values);
  SpreadsheetApp.flush();

  var confirm = UrlFetchApp.fetch(STRIPE_ORDERS_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + secret },
    payload: JSON.stringify({ ids: data.ids }),
    muteHttpExceptions: true,
  });

  if (confirm.getResponseCode() !== 200) {
    // The rows are on the tab but unmarked, so the next run would append them
    // again. Say so loudly rather than leaving a silent duplicate.
    console.error('stripe orders appended but NOT confirmed — check for duplicates');
    return 'orders: ' + data.values.length + ' appended, CONFIRM FAILED';
  }

  return 'orders: ' + data.values.length + ' appended';
}

/**
 * The first row above `floorRow` with nobody's name on it — the row a person
 * would type into next. `floorRow` itself when the sheet is full.
 *
 * Name is the test rather than "row is empty" because the free rows are not
 * empty: they carry dragged-down checkboxes and formatting. A row with no
 * purchaser on it holds no purchase, whatever else is sitting in it.
 */
function findFirstFreeRow(sheet, floorRow) {
  if (floorRow <= 2) return 2;
  var names = sheet.getRange(2, 2, floorRow - 2, 1).getDisplayValues();
  for (var i = 0; i < names.length; i++) {
    if (!String(names[i][0]).trim()) return i + 2; // getRange is 1-based
  }
  return floorRow;
}

/**
 * How many free rows run consecutively from `startRow`.
 *
 * Consecutive on purpose: a single blank row left in the middle of the ledger
 * gets filled, but the batch stops there rather than writing straight over the
 * names underneath it.
 */
function countFreeRowsFrom(sheet, startRow, floorRow) {
  if (startRow >= floorRow) return 0;
  var names = sheet.getRange(startRow, 2, floorRow - startRow, 1).getDisplayValues();
  var n = 0;
  while (n < names.length && !String(names[n][0]).trim()) n++;
  return n;
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
