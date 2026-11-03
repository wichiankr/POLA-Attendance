/** POLA WFH Attendance | Version 1.1 | Workspace same-domain identities only. */
const TZ = 'Asia/Bangkok';
const SHEET_EMP = 'Employees';
const SHEET_LOG = 'Attendance';
// Keep the original columns intact. EmployeeId is an appended column.
const HEAD_EMP = ['Email','FullName','Department','Active','EmployeeId'];
const HEAD_LOG = ['RecordId','Email','FullName','Department','WorkDate','ClockIn','ClockOut','Status','Notes','EmployeeId'];

/** Safe to run again: adds missing headers; does NOT erase employee or attendance records. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('WFH Attendance - POLA');
  if (!id) props.setProperty('SPREADSHEET_ID', ss.getId());
  initializeSheet_(ss, SHEET_EMP, HEAD_EMP);
  initializeSheet_(ss, SHEET_LOG, HEAD_LOG);
  // Format EmployeeId columns as text so leading zeros are never dropped.
  const emp = ss.getSheetByName(SHEET_EMP);
  const log = ss.getSheetByName(SHEET_LOG);
  emp.getRange(2, 5, emp.getMaxRows()-1, 1).setNumberFormat('@');
  log.getRange(2, 10, log.getMaxRows()-1, 1).setNumberFormat('@');
  const rule = SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=OR(E2="",REGEXMATCH(TO_TEXT(E2),"^[0-9]{4}$"))')
    .setAllowInvalid(false)
    .setHelpText('Enter exactly 4 digits, e.g. 0097')
    .build();
  emp.getRange(2, 5, emp.getMaxRows()-1, 1).setDataValidation(rule);
  Logger.log('Spreadsheet URL: ' + ss.getUrl());
}

function initializeSheet_(ss, name, headers) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8eef8');
  } else {
    for (let i = 0; i < headers.length; i++) {
      const actual = String(sh.getRange(1, i + 1).getDisplayValue()).trim();
      if (!actual) sh.getRange(1, i + 1).setValue(headers[i]);
      else if (actual !== headers[i]) {
        throw new Error('Unexpected column in ' + name + ', column ' + (i + 1) + ': ' + actual);
      }
    }
  }
  return sh;
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('POLA | WFH Attendance')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getDb_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('Administrator must run setup() first.');
  return SpreadsheetApp.openById(id);
}

function employee_() {
  // Do not trust user-submitted email or employee number: use verified Workspace identity.
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) throw new Error('Cannot verify your Google account. This version requires a same-domain Google Workspace login, not a personal Gmail account.');
  const sh = getDb_().getSheetByName(SHEET_EMP);
  const rows = sh.getDataRange().getDisplayValues();
  let user = null;
  const activeIds = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rowEmail = String(r[0] || '').trim().toLowerCase();
    const active = String(r[3] || '').trim().toLowerCase() === 'true';
    if (!active || !rowEmail) continue;
    const employeeId = String(r[4] || '').trim();
    if (rowEmail === email) {
      if (user) throw new Error('Duplicate active employee email. Contact HR.');
      user = {email:email, name:r[1], department:r[2], employeeId:employeeId};
    }
    if (employeeId && /^[0-9]{4}$/.test(employeeId)) {
      if (activeIds.has(employeeId)) throw new Error('Duplicate EmployeeId in Employees sheet: ' + employeeId + '. Contact HR.');
      activeIds.add(employeeId);
    }
  }
  if (!user) throw new Error('This account is not in the active employee allowlist. Contact HR.');
  if (!/^[0-9]{4}$/.test(user.employeeId)) {
    throw new Error('EmployeeId is missing or invalid. HR must enter exactly 4 digits (example: 0097) in Employees column E.');
  }
  return user;
}

function dateKey_(date) { return Utilities.formatDate(date, TZ, 'yyyy-MM-dd'); }
function timeText_(date) { return Utilities.formatDate(date, TZ, 'yyyy-MM-dd HH:mm:ss'); }

function findToday_(sh, employeeId, email, day) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const rows = sh.getRange(2, 1, last - 1, 10).getDisplayValues();
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    // For migration, match existing attendance rows by email when EmployeeId is blank.
    const sameUser = String(r[9] || '').trim()
      ? String(r[9]).trim() === employeeId
      : String(r[1]).trim().toLowerCase() === email;
    if (sameUser && r[4] === day) return {row:i + 2, data:r};
  }
  return null;
}

function getDashboard() {
  const user = employee_();
  const sh = getDb_().getSheetByName(SHEET_LOG);
  const today = dateKey_(new Date());
  const current = findToday_(sh, user.employeeId, user.email, today);
  let history = [];
  if (sh.getLastRow() > 1) {
    history = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getDisplayValues()
      .filter(r => String(r[9] || '').trim()
        ? String(r[9]).trim() === user.employeeId
        : String(r[1]).trim().toLowerCase() === user.email)
      .slice(-10).reverse()
      .map(r => ({date:r[4], clockIn:r[5], clockOut:r[6], status:r[7]}));
  }
  return {user:user, today:today, serverNow:timeText_(new Date()),
    status:current ? current.data[7] : 'NOT_STARTED',
    clockIn:current ? current.data[5] : '',
    clockOut:current ? current.data[6] : '', history:history};
}

function clock(action) {
  if (action !== 'IN' && action !== 'OUT') throw new Error('Invalid action');
  const user = employee_();
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = getDb_().getSheetByName(SHEET_LOG);
    const now = new Date();
    const today = dateKey_(now);
    const found = findToday_(sh, user.employeeId, user.email, today);
    if (action === 'IN') {
      if (found) throw new Error('You already clocked in today.');
      sh.appendRow([Utilities.getUuid(), user.email, user.name, user.department, today,
        timeText_(now), '', 'WORKING', '', user.employeeId]);
    } else {
      if (!found) throw new Error('Please clock in first.');
      if (found.data[7] !== 'WORKING' || found.data[6]) throw new Error('Already clocked out today.');
      sh.getRange(found.row, 7, 1, 2).setValues([[timeText_(now), 'COMPLETED']]);
      // Backfill EmployeeId when clocking out of a record created by version 1.0.
      if (!String(found.data[9] || '').trim()) sh.getRange(found.row, 10).setValue(user.employeeId);
    }
    SpreadsheetApp.flush();
    return getDashboard();
  } finally {
    lock.releaseLock();
  }
}
