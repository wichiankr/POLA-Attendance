/**
 * POLA WFH Attendance | Version 1.3
 * Two ways in:
 *  - Google web app (doGet + google.script.run): identity = same-domain Google Workspace login.
 *  - LINE LIFF (doPost JSON API): identity = LINE ID token verified with LINE, linked to an employee
 *    once by a one-time code sent to the employee's company email.
 */
const TZ = 'Asia/Bangkok';
const TZ_OFFSET = '+07:00'; // Asia/Bangkok has no DST.
const SHEET_EMP = 'Employees';
const SHEET_LOG = 'Attendance';
// Keep the original columns intact. EmployeeId and LineUserId are appended columns.
const HEAD_EMP = ['Email','FullName','Department','Active','EmployeeId','LineUserId'];
const HEAD_LOG = ['RecordId','Email','FullName','Department','WorkDate','ClockIn','ClockOut','Status','Notes','EmployeeId'];
// Column indexes (0-based).
const E = {EMAIL:0, NAME:1, DEPT:2, ACTIVE:3, EMP_ID:4, LINE:5};
const L = {ID:0, EMAIL:1, NAME:2, DEPT:3, DATE:4, IN:5, OUT:6, STATUS:7, NOTES:8, EMP_ID:9};
const EMP_ID_RE = /^[0-9]{4}$/;
// A shift that started yesterday (overnight work) can still be clocked out within this window.
const MAX_SHIFT_HOURS = 20;
const HISTORY_SIZE = 10;
// LINE account linking.
const LINK_TTL_SEC = 600;
const LINK_MAX_TRIES = 5;
const LINK_RESEND_SEC = 60;
const REMINDER_HOUR = 19;

/**
 * Safe to run again: adds missing headers; does NOT erase employee or attendance records.
 * Run it from the script editor only — it refuses to run through the web app.
 */
function setup() {
  assertOwner_();
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SPREADSHEET_ID');
  const ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.create('WFH Attendance - POLA');
  if (!id) props.setProperty('SPREADSHEET_ID', ss.getId());
  const emp = initializeSheet_(ss, SHEET_EMP, HEAD_EMP);
  const log = initializeSheet_(ss, SHEET_LOG, HEAD_LOG);
  // Store every attendance cell as plain text: keeps leading zeros in EmployeeId, stops Sheets from
  // re-parsing "yyyy-MM-dd" into locale-formatted dates, and neutralises formula injection ("=...").
  log.getRange(2, 1, Math.max(log.getMaxRows() - 1, 1), HEAD_LOG.length).setNumberFormat('@');
  emp.getRange(2, E.EMP_ID + 1, Math.max(emp.getMaxRows() - 1, 1), 2).setNumberFormat('@');
  const rule = SpreadsheetApp.newDataValidation()
    .requireFormulaSatisfied('=OR(E2="",REGEXMATCH(TO_TEXT(E2),"^[0-9]{4}$"))')
    .setAllowInvalid(false)
    .setHelpText('Enter exactly 4 digits, e.g. 0097')
    .build();
  emp.getRange(2, E.EMP_ID + 1, Math.max(emp.getMaxRows() - 1, 1), 1).setDataValidation(rule);
  Logger.log('Spreadsheet URL: ' + ss.getUrl());
}

/** Web-app calls run as the deployer, so the active user (employee) differs from the effective user. */
function assertOwner_() {
  const active = Session.getActiveUser().getEmail();
  const effective = Session.getEffectiveUser().getEmail();
  if (!active || active !== effective) throw new Error('This function can only be run by the script owner from the editor.');
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
  if (!id) throw new Error('ระบบยังไม่พร้อมใช้งาน: ผู้ดูแลต้องรัน setup() ก่อน');
  return SpreadsheetApp.openById(id);
}

/** Error with a machine-readable code for the LIFF client. */
function fail_(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isActive_(value) {
  return ['true', 'yes', 'y', '1', 'ใช่'].indexOf(String(value || '').trim().toLowerCase()) !== -1;
}

/** Finds the single active employee for which test(email, lineUserId) is true, or null. */
function employeeWhere_(ss, test) {
  const rows = ss.getSheetByName(SHEET_EMP).getDataRange().getDisplayValues();
  let user = null;
  const idCount = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rowEmail = String(r[E.EMAIL] || '').trim().toLowerCase();
    if (!rowEmail || !isActive_(r[E.ACTIVE])) continue;
    const employeeId = String(r[E.EMP_ID] || '').trim();
    const lineUserId = String(r[E.LINE] || '').trim();
    idCount[employeeId] = (idCount[employeeId] || 0) + 1;
    if (test(rowEmail, lineUserId)) {
      if (user) throw new Error('พบข้อมูลของคุณซ้ำในรายชื่อพนักงาน กรุณาติดต่อ HR');
      user = {email:rowEmail, name:String(r[E.NAME]).trim(), department:String(r[E.DEPT]).trim(),
        employeeId:employeeId, lineUserId:lineUserId, row:i + 1};
    }
  }
  if (!user) return null;
  if (!EMP_ID_RE.test(user.employeeId)) {
    throw new Error('รหัสพนักงานของคุณไม่ถูกต้องหรือยังไม่ได้กำหนด กรุณาติดต่อ HR (ต้องเป็นตัวเลข 4 หลัก)');
  }
  // Only block the user whose own ID is duplicated, instead of locking out the whole company.
  if (idCount[user.employeeId] > 1) throw new Error('รหัสพนักงานของคุณซ้ำกับพนักงานคนอื่น กรุณาติดต่อ HR');
  return user;
}

function employee_(ss) {
  // Do not trust user-submitted email or employee number: use verified Workspace identity.
  const email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!email) throw new Error('ไม่สามารถยืนยันบัญชี Google ได้ กรุณาเข้าสู่ระบบด้วยบัญชี Google Workspace ของบริษัท (ไม่ใช่ Gmail ส่วนตัว)');
  const user = employeeWhere_(ss, rowEmail => rowEmail === email);
  if (!user) throw new Error('บัญชีนี้ไม่อยู่ในรายชื่อพนักงานที่ใช้งานอยู่ กรุณาติดต่อ HR');
  return user;
}

function employeeByLine_(ss, lineUserId) {
  const user = employeeWhere_(ss, (rowEmail, rowLine) => rowLine === lineUserId);
  if (!user) throw fail_('NOT_LINKED', 'บัญชี LINE นี้ยังไม่ได้เชื่อมกับพนักงาน');
  return user;
}

function dateKey_(date) { return Utilities.formatDate(date, TZ, 'yyyy-MM-dd'); }
function timeText_(date) { return Utilities.formatDate(date, TZ, 'yyyy-MM-dd HH:mm:ss'); }
function parseTime_(text) {
  const d = text ? new Date(text.replace(' ', 'T') + TZ_OFFSET) : null;
  return d && !isNaN(d) ? d : null;
}

/**
 * Normalises one Attendance row. Rows written by v1.0/1.1 via appendRow() may have been auto-converted
 * by Sheets into Date / Number cells, so compare on raw values instead of locale-dependent display text.
 */
function normalizeRow_(r) {
  const cell = (v, fmt) => v instanceof Date ? Utilities.formatDate(v, TZ, fmt) : String(v == null ? '' : v).trim();
  const empId = typeof r[L.EMP_ID] === 'number' ? String(r[L.EMP_ID]).padStart(4, '0') : cell(r[L.EMP_ID]);
  return {
    email: cell(r[L.EMAIL]).toLowerCase(),
    date: cell(r[L.DATE], 'yyyy-MM-dd'),
    clockIn: cell(r[L.IN], 'yyyy-MM-dd HH:mm:ss'),
    clockOut: cell(r[L.OUT], 'yyyy-MM-dd HH:mm:ss'),
    status: cell(r[L.STATUS]).toUpperCase(),
    empId: empId
  };
}

function isSameUser_(rec, user) {
  // For migration, match existing attendance rows by email when EmployeeId is blank.
  return rec.empId ? rec.empId === user.employeeId : rec.email === user.email;
}

function isOpen_(rec) { return rec.status === 'WORKING' && !rec.clockOut; }

/** One pass over the log: today's record, the shift that can still be clocked out, and recent history. */
function userState_(sh, user, now) {
  const today = dateKey_(now);
  const last = sh.getLastRow();
  const rows = last < 2 ? [] : sh.getRange(2, 1, last - 1, HEAD_LOG.length).getValues();
  let todayRec = null, openRec = null;
  const mine = [];
  const yesterday = dateKey_(new Date(now - 864e5));
  for (let i = rows.length - 1; i >= 0; i--) {
    const rec = normalizeRow_(rows[i]);
    if (!isSameUser_(rec, user)) continue;
    rec.row = i + 2;
    if (mine.length < HISTORY_SIZE) mine.push(rec);
    if (!todayRec && rec.date === today) todayRec = rec;
    if (!openRec && isOpen_(rec)) {
      const start = parseTime_(rec.clockIn);
      const fresh = rec.date === today || (start && now - start <= MAX_SHIFT_HOURS * 3600e3);
      if (fresh) openRec = rec;
    }
    // Stop scanning once we are past yesterday and already have the history we need.
    if (mine.length >= HISTORY_SIZE && rec.date < yesterday) break;
  }
  return {today:today, todayRec:todayRec, openRec:openRec, mine:mine};
}

function hours_(rec) {
  const a = parseTime_(rec.clockIn), b = parseTime_(rec.clockOut);
  return a && b && b > a ? Math.round((b - a) / 36e3) / 100 : null;
}

function dashboard_(ss, user, now) {
  const st = userState_(ss.getSheetByName(SHEET_LOG), user, now);
  const current = st.openRec || st.todayRec;
  const status = st.openRec ? 'WORKING' : st.todayRec ? 'COMPLETED' : 'NOT_STARTED';
  return {
    // Only what the page needs: never send the sheet row or LINE user ID back to the client.
    user: {email:user.email, name:user.name, department:user.department, employeeId:user.employeeId},
    today: st.today,
    serverEpoch: now.getTime(),
    status: status,
    workDate: current ? current.date : st.today,
    clockIn: current ? current.clockIn : '',
    clockOut: current ? current.clockOut : '',
    clockInEpoch: current && parseTime_(current.clockIn) ? parseTime_(current.clockIn).getTime() : null,
    history: st.mine.map(r => ({
      date: r.date, clockIn: r.clockIn, clockOut: r.clockOut, hours: hours_(r),
      // An open shift that is no longer the current one was never clocked out.
      status: isOpen_(r) && (!st.openRec || st.openRec.row !== r.row) ? 'MISSED_OUT' : r.status || 'UNKNOWN'
    }))
  };
}

function lock_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw fail_('BUSY', 'ระบบกำลังมีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกครั้งในไม่กี่วินาที');
  return lock;
}

function clockFor_(ss, user, action) {
  if (action !== 'IN' && action !== 'OUT') throw fail_('RULE', 'คำสั่งไม่ถูกต้อง');
  const lock = lock_();
  try {
    const sh = ss.getSheetByName(SHEET_LOG);
    const now = new Date();
    const st = userState_(sh, user, now);
    if (action === 'IN') {
      if (st.openRec) throw fail_('RULE', 'คุณยังไม่ได้ลงเวลาออกจากกะที่เริ่มเมื่อ ' + st.openRec.clockIn);
      if (st.todayRec) throw fail_('RULE', 'วันนี้คุณลงเวลาเข้างานไปแล้ว');
      const values = [Utilities.getUuid(), user.email, user.name, user.department, st.today,
        timeText_(now), '', 'WORKING', '', user.employeeId];
      // Explicit text-formatted write instead of appendRow(), so Sheets cannot re-type the values.
      sh.getRange(sh.getLastRow() + 1, 1, 1, values.length).setNumberFormat('@').setValues([values]);
    } else {
      if (!st.openRec) throw fail_('RULE', st.todayRec ? 'วันนี้คุณลงเวลาออกงานไปแล้ว' : 'กรุณาลงเวลาเข้างานก่อน');
      sh.getRange(st.openRec.row, L.OUT + 1, 1, 2).setNumberFormat('@').setValues([[timeText_(now), 'COMPLETED']]);
      // Backfill EmployeeId when clocking out of a record created by version 1.0.
      if (!st.openRec.empId) sh.getRange(st.openRec.row, L.EMP_ID + 1).setNumberFormat('@').setValue(user.employeeId);
    }
    SpreadsheetApp.flush();
    return dashboard_(ss, user, now);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Google web app (google.script.run) ---------- */

function getDashboard() {
  const ss = getDb_();
  return dashboard_(ss, employee_(ss), new Date());
}

function clock(action) {
  const ss = getDb_();
  return clockFor_(ss, employee_(ss), action);
}

/* ---------- LINE LIFF JSON API ---------- */

/**
 * Body (sent as text/plain to avoid a CORS preflight): {"idToken": "...", "action": "...", ...}
 * The LINE user is taken ONLY from the ID token verified by LINE, never from the request body.
 */
function doPost(e) {
  let out;
  try {
    const body = (e && e.postData && e.postData.contents) || '';
    if (body.length > 10000) throw fail_('INPUT', 'คำขอไม่ถูกต้อง');
    const req = JSON.parse(body || '{}');
    const lineUserId = verifyLineToken_(req.idToken);
    const ss = getDb_();
    let data;
    switch (req.action) {
      case 'dashboard': data = dashboard_(ss, employeeByLine_(ss, lineUserId), new Date()); break;
      case 'clock': data = clockFor_(ss, employeeByLine_(ss, lineUserId), req.clockAction); break;
      case 'linkStart': data = linkStart_(ss, lineUserId, req.email); break;
      case 'linkVerify': data = linkVerify_(ss, lineUserId, req.code); break;
      default: throw fail_('INPUT', 'คำสั่งไม่ถูกต้อง');
    }
    out = {ok:true, data:data};
  } catch (err) {
    if (!err.code) console.error(err);
    out = {ok:false, code:err.code || 'ERROR', error:String((err && err.message) || err)};
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Verifies a LIFF ID token with LINE and returns the LINE user ID (sub). */
function verifyLineToken_(idToken) {
  const channelId = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ID');
  if (!channelId) throw new Error('ระบบยังไม่ได้ตั้งค่า LINE_CHANNEL_ID');
  if (typeof idToken !== 'string' || !idToken || idToken.length > 4096) {
    throw fail_('AUTH', 'ไม่พบการเข้าสู่ระบบ LINE กรุณาเปิดแอปใหม่');
  }
  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post', payload: {id_token:idToken, client_id:channelId}, muteHttpExceptions: true});
  if (res.getResponseCode() !== 200) throw fail_('AUTH', 'การเข้าสู่ระบบ LINE หมดอายุ กรุณาเปิดแอปใหม่');
  const p = JSON.parse(res.getContentText());
  if (p.iss !== 'https://access.line.me' || p.aud !== channelId || !p.sub || p.exp * 1000 < Date.now()) {
    throw fail_('AUTH', 'การเข้าสู่ระบบ LINE ไม่ถูกต้อง กรุณาเปิดแอปใหม่');
  }
  return p.sub;
}

function sha_(text) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8));
}

/** 6 digits from a v4 UUID (SecureRandom-backed), unlike Math.random(). */
function otp_() {
  return String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 1e6).padStart(6, '0');
}

/** Step 1 of linking: email a one-time code to the employee's company address. */
function linkStart_(ss, lineUserId, email) {
  email = String(email || '').trim().toLowerCase();
  if (email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw fail_('INPUT', 'รูปแบบอีเมลไม่ถูกต้อง');
  const cache = CacheService.getScriptCache();
  // Throttle per LINE account and per mailbox, so the form cannot be used to flood an inbox.
  if (cache.get('linkwait:' + lineUserId) || cache.get('linkmail:' + sha_(email))) {
    throw fail_('RATE', 'เพิ่งส่งรหัสไปแล้ว กรุณารอ 1 นาทีก่อนขอใหม่');
  }
  cache.put('linkwait:' + lineUserId, '1', LINK_RESEND_SEC);
  cache.put('linkmail:' + sha_(email), '1', LINK_RESEND_SEC);
  let user = null;
  try { user = employeeWhere_(ss, rowEmail => rowEmail === email); } catch (err) { user = null; }
  // Same reply whether or not the address is an employee, so it cannot be used to discover who works here.
  if (user) {
    const code = otp_();
    cache.put('link:' + lineUserId, JSON.stringify({email:email, hash:sha_(code + ':' + lineUserId), tries:0}), LINK_TTL_SEC);
    MailApp.sendEmail({
      to: email,
      subject: 'รหัสยืนยันการเชื่อมบัญชี LINE | POLA WFH Attendance',
      body: 'รหัสยืนยันของคุณคือ ' + code + '\n\nรหัสนี้ใช้ได้ภายใน 10 นาที เพื่อเชื่อมบัญชี LINE กับระบบลงเวลาทำงาน\n' +
        'หากคุณไม่ได้ขอรหัสนี้ ไม่ต้องดำเนินการใดๆ และห้ามส่งรหัสนี้ให้ผู้อื่น'
    });
  }
  return {sent:true};
}

/** Step 2 of linking: check the code, then store the LINE user ID on the employee row. */
function linkVerify_(ss, lineUserId, code) {
  const cache = CacheService.getScriptCache();
  const key = 'link:' + lineUserId;
  const raw = cache.get(key);
  if (!raw) throw fail_('LINK_EXPIRED', 'รหัสหมดอายุหรือยังไม่ได้ขอรหัส กรุณาขอรหัสใหม่');
  const st = JSON.parse(raw);
  if (sha_(String(code || '').trim() + ':' + lineUserId) !== st.hash) {
    st.tries++;
    if (st.tries >= LINK_MAX_TRIES) {
      cache.remove(key);
      throw fail_('LINK_EXPIRED', 'กรอกรหัสผิดเกินกำหนด กรุณาขอรหัสใหม่');
    }
    cache.put(key, JSON.stringify(st), LINK_TTL_SEC);
    throw fail_('LINK_CODE', 'รหัสไม่ถูกต้อง (เหลือ ' + (LINK_MAX_TRIES - st.tries) + ' ครั้ง)');
  }
  cache.remove(key);
  const lock = lock_();
  try {
    const user = employeeWhere_(ss, rowEmail => rowEmail === st.email);
    if (!user) throw new Error('บัญชีนี้ไม่อยู่ในรายชื่อพนักงานที่ใช้งานอยู่ กรุณาติดต่อ HR');
    const sh = ss.getSheetByName(SHEET_EMP);
    // One LINE account maps to one employee: detach it from any other row first.
    const lines = sh.getRange(1, E.LINE + 1, sh.getLastRow(), 1).getValues();
    lines.forEach((v, i) => {
      if (i > 0 && i + 1 !== user.row && String(v[0]).trim() === lineUserId) sh.getRange(i + 1, E.LINE + 1).setValue('');
    });
    sh.getRange(user.row, E.LINE + 1).setNumberFormat('@').setValue(lineUserId);
    SpreadsheetApp.flush();
    user.lineUserId = lineUserId;
    return dashboard_(ss, user, new Date());
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Optional: LINE reminder (needs LINE_MESSAGING_TOKEN) ---------- */

/** Run once from the editor to send a daily clock-out reminder at REMINDER_HOUR. */
function installReminder() {
  assertOwner_();
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'remindClockOut')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('remindClockOut').timeBased().everyDays(1).atHour(REMINDER_HOUR).inTimezone(TZ).create();
}

/** Pushes a LINE message to every linked employee who is still clocked in. */
function remindClockOut(e) {
  // Public function, so google.script.run could call it: only allow our own trigger or the owner.
  const fromTrigger = e && e.triggerUid && ScriptApp.getProjectTriggers().some(t => t.getUniqueId() === String(e.triggerUid));
  if (!fromTrigger) assertOwner_();
  const token = PropertiesService.getScriptProperties().getProperty('LINE_MESSAGING_TOKEN');
  if (!token) return;
  const ss = getDb_();
  const lineById = {};
  ss.getSheetByName(SHEET_EMP).getDataRange().getDisplayValues().slice(1).forEach(r => {
    if (isActive_(r[E.ACTIVE]) && r[E.LINE]) lineById[String(r[E.EMP_ID]).trim()] = String(r[E.LINE]).trim();
  });
  const today = dateKey_(new Date());
  const sh = ss.getSheetByName(SHEET_LOG);
  const last = sh.getLastRow();
  if (last < 2) return;
  const sent = {};
  sh.getRange(2, 1, last - 1, HEAD_LOG.length).getValues().map(normalizeRow_).forEach(rec => {
    const to = lineById[rec.empId];
    if (!to || sent[to] || rec.date !== today || !isOpen_(rec)) return;
    sent[to] = true;
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: {Authorization: 'Bearer ' + token},
      payload: JSON.stringify({to:to, messages:[{type:'text',
        text:'⏰ คุณยังไม่ได้ลงเวลาออกงานวันนี้ (เข้างาน ' + rec.clockIn.slice(11, 16) + ' น.) อย่าลืมกด Clock Out นะครับ'}]})
    });
  });
}
