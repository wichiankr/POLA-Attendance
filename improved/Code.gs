/**
 * POLA WFH Attendance | Version 2.0 (punch model: first punch = clock-in, last punch = clock-out)
 * Two ways in:
 *  - Google web app (doGet + google.script.run): identity = same-domain Google Workspace login.
 *  - LINE LIFF (doPost JSON API): identity = LINE ID token verified with LINE, linked to an employee
 *    once by a one-time code sent to the employee's company email.
 */
const TZ = 'Asia/Bangkok';
const TZ_OFFSET = '+07:00'; // Asia/Bangkok has no DST.
const SHEET_EMP = 'Employees';
const SHEET_LOG = 'Attendance'; // v1.x sessions, read-only from v2.0
const SHEET_PUNCH = 'Punches';
// Keep the original columns intact. EmployeeId, LineUserId and the location columns are appended.
const HEAD_EMP = ['Email','FullName','Department','Active','EmployeeId','LineUserId'];
const HEAD_LOG = ['RecordId','Email','FullName','Department','WorkDate','ClockIn','ClockOut','Status','Notes','EmployeeId',
  'InLocation','InAccuracyM','InPlace','OutLocation','OutAccuracyM','OutPlace'];
// Column indexes (0-based).
const E = {EMAIL:0, NAME:1, DEPT:2, ACTIVE:3, EMP_ID:4, LINE:5};
const L = {ID:0, EMAIL:1, NAME:2, DEPT:3, DATE:4, IN:5, OUT:6, STATUS:7, NOTES:8, EMP_ID:9, IN_LOC:10, OUT_LOC:13};
// One row per tap. Append-only, so it doubles as the audit log.
const HEAD_PUNCH = ['PunchId','Email','FullName','Department','WorkDate','PunchTime','EmployeeId','Location','AccuracyM','Place','Source'];
const P = {ID:0, EMAIL:1, NAME:2, DEPT:3, DATE:4, TIME:5, EMP_ID:6, LOC:7, ACC:8, PLACE:9, SOURCE:10};
const EMP_ID_RE = /^[0-9]{4}$/;
const HISTORY_SIZE = 10; // days
// Work hours = last punch − first punch, minus LUNCH_BREAK_MIN once the span exceeds LUNCH_AFTER_HOURS.
const LUNCH_BREAK_MIN = 60;
const LUNCH_AFTER_HOURS = 5;
// Taps closer together than this are a double tap, not a new punch.
const PUNCH_GAP_SEC = 60;
// LINE account linking.
const LINK_TTL_SEC = 600;
const LINK_MAX_TRIES = 5;
const LINK_RESEND_SEC = 60;
const REMINDER_HOUR = 19;
// Location tagging: every punch must carry a GPS fix.
const MAX_ACCURACY_M = 100000;

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
  const punches = punchSheet_(ss);
  punches.getRange(2, 1, Math.max(punches.getMaxRows() - 1, 1), HEAD_PUNCH.length).setNumberFormat('@');
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

/** Gmail ignores dots and "+tag" in the local part, so a.b+x@gmail.com and ab@gmail.com are one inbox. */
function canonicalEmail_(email) {
  const m = String(email || '').trim().toLowerCase().match(/^([^@]+)@(gmail\.com|googlemail\.com)$/);
  return m ? m[1].split('+')[0].replace(/\./g, '') + '@gmail.com' : String(email || '').trim().toLowerCase();
}
function sameEmail_(a, b) { return canonicalEmail_(a) === canonicalEmail_(b); }

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
  const user = employeeWhere_(ss, rowEmail => sameEmail_(rowEmail, email));
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
function cell_(v, fmt) { return v instanceof Date ? Utilities.formatDate(v, TZ, fmt) : String(v == null ? '' : v).trim(); }
// v1.1 appendRow() turned "0097" into 97 (number, or text "97" once the column was reformatted).
function empIdOf_(raw) { return /^[0-9]{1,3}$/.test(raw) ? raw.padStart(4, '0') : raw; }

function normalizeRow_(r) {
  const cell = cell_;
  const empId = empIdOf_(cell(r[L.EMP_ID]));
  return {
    email: cell(r[L.EMAIL]).toLowerCase(),
    date: cell(r[L.DATE], 'yyyy-MM-dd'),
    clockIn: cell(r[L.IN], 'yyyy-MM-dd HH:mm:ss'),
    clockOut: cell(r[L.OUT], 'yyyy-MM-dd HH:mm:ss'),
    status: cell(r[L.STATUS]).toUpperCase(),
    empId: empId,
    inLoc: cell(r[L.IN_LOC]), inAcc: cell(r[L.IN_LOC + 1]), inPlace: cell(r[L.IN_LOC + 2]),
    outLoc: cell(r[L.OUT_LOC]), outAcc: cell(r[L.OUT_LOC + 1]), outPlace: cell(r[L.OUT_LOC + 2])
  };
}

function isSameUser_(rec, user) {
  // For migration, match existing attendance rows by email when EmployeeId is blank.
  return rec.empId ? rec.empId === user.employeeId : rec.email === user.email;
}

/* ---------- Punches: clock-in = earliest punch of the day, clock-out = latest ---------- */

/** The Punches sheet, created on first use so a missed setup() re-run cannot break clocking. */
function punchSheet_(ss) {
  let sh = ss.getSheetByName(SHEET_PUNCH);
  if (!sh) {
    sh = initializeSheet_(ss, SHEET_PUNCH, HEAD_PUNCH);
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), HEAD_PUNCH.length).setNumberFormat('@');
  }
  return sh;
}

function punchOf_(who, time, loc, acc, place) {
  const d = parseTime_(time);
  // Calendar day of the punch itself (00:00–23:59 Bangkok), not the old WorkDate column.
  return {email:who.email, empId:who.empId, time:time, date:time.slice(0, 10), epoch:d ? d.getTime() : 0,
    loc:loc, acc:acc, place:place};
}

/**
 * Every punch in the spreadsheet: rows of the Punches sheet, plus the ClockIn / ClockOut of each
 * legacy Attendance row (v1.x sessions), so older history keeps showing.
 */
function allPunches_(ss) {
  const out = [];
  const log = ss.getSheetByName(SHEET_LOG);
  if (log && log.getLastRow() > 1) {
    log.getRange(2, 1, log.getLastRow() - 1, HEAD_LOG.length).getValues().forEach(r => {
      const rec = normalizeRow_(r);
      if (rec.clockIn) out.push(punchOf_(rec, rec.clockIn, rec.inLoc, rec.inAcc, rec.inPlace));
      if (rec.clockOut) out.push(punchOf_(rec, rec.clockOut, rec.outLoc, rec.outAcc, rec.outPlace));
    });
  }
  const ps = ss.getSheetByName(SHEET_PUNCH);
  if (ps && ps.getLastRow() > 1) {
    ps.getRange(2, 1, ps.getLastRow() - 1, HEAD_PUNCH.length).getValues().forEach(r => {
      const who = {email:cell_(r[P.EMAIL]).toLowerCase(), empId:empIdOf_(cell_(r[P.EMP_ID]))};
      out.push(punchOf_(who, cell_(r[P.TIME], 'yyyy-MM-dd HH:mm:ss'), cell_(r[P.LOC]), cell_(r[P.ACC]), cell_(r[P.PLACE])));
    });
  }
  return out.filter(p => p.epoch);
}

/** The user's punches grouped by day: {byDate: {date: [punch…] oldest first}, dates: newest first, latest}. */
function userDays_(ss, user) {
  const mine = allPunches_(ss).filter(p => isSameUser_(p, user)).sort((a, b) => a.epoch - b.epoch);
  const byDate = {};
  mine.forEach(p => (byDate[p.date] = byDate[p.date] || []).push(p));
  return {byDate:byDate, dates:Object.keys(byDate).sort().reverse(), latest:mine[mine.length - 1] || null};
}

/** Hours rule: latest − earliest, minus a lunch break once the span is longer than LUNCH_AFTER_HOURS. */
function workedMs_(spanMs) {
  return Math.max(0, spanMs - (spanMs > LUNCH_AFTER_HOURS * 3600e3 ? LUNCH_BREAK_MIN * 60e3 : 0));
}

function daySummary_(punches) {
  const first = punches[0], last = punches.length > 1 ? punches[punches.length - 1] : null;
  return {first:first, last:last, count:punches.length, workedMs:last ? workedMs_(last.epoch - first.epoch) : 0};
}

function dashboard_(ss, user, now) {
  const today = dateKey_(now);
  const days = userDays_(ss, user);
  const sum = days.byDate[today] ? daySummary_(days.byDate[today]) : null;
  const status = !sum ? 'NOT_STARTED' : sum.count === 1 ? 'IN' : 'DONE';
  const view = p => p ? locationView_(p.loc, p.acc, p.place) : null;
  return {
    // Only what the page needs: never send the sheet row or LINE user ID back to the client.
    user: {email:user.email, name:user.name, department:user.department, employeeId:user.employeeId},
    today: today,
    serverEpoch: now.getTime(),
    status: status,
    clockIn: sum ? sum.first.time : '',
    clockOut: sum && sum.last ? sum.last.time : '',
    clockInEpoch: sum ? sum.first.epoch : null,
    workedMs: sum ? sum.workedMs : 0,
    punchCount: sum ? sum.count : 0,
    // Lets the page count hours live after the first punch with the same lunch rule.
    lunchBreakMs: LUNCH_BREAK_MIN * 60e3,
    lunchAfterMs: LUNCH_AFTER_HOURS * 3600e3,
    locationRequired: true,
    inLocation: sum ? view(sum.first) : null,
    outLocation: sum ? view(sum.last) : null,
    punchesToday: (days.byDate[today] || []).map(p => ({time:p.time, location:view(p)})),
    history: days.dates.slice(0, HISTORY_SIZE).map(date => {
      const s = daySummary_(days.byDate[date]);
      return {date:date, clockIn:s.first.time, clockOut:s.last ? s.last.time : '', punches:s.count,
        hours:s.last ? Math.round(s.workedMs / 36e3) / 100 : null,
        // A finished day with a single punch never got a clock-out.
        status:s.last ? 'COMPLETED' : date === today ? 'IN' : 'MISSED_OUT'};
    })
  };
}

function lock_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw fail_('BUSY', 'ระบบกำลังมีผู้ใช้งานจำนวนมาก กรุณาลองใหม่อีกครั้งในไม่กี่วินาที');
  return lock;
}

/** Records one punch. Location is mandatory; a second tap within PUNCH_GAP_SEC is treated as a double tap. */
function punchFor_(ss, user, location, source) {
  const loc = parseLocation_(location);
  if (!loc) throw fail_('LOCATION', 'ต้องอนุญาตให้เข้าถึงตำแหน่งก่อนลงเวลา กรุณาเปิด Location แล้วลองใหม่');
  // Reverse geocoding is a network call: do it before taking the lock.
  const place = placeName_(loc);
  const lock = lock_();
  try {
    const now = new Date();
    const latest = userDays_(ss, user).latest;
    if (latest && now - latest.epoch < PUNCH_GAP_SEC * 1000) {
      throw fail_('DUPLICATE', 'เพิ่งลงเวลาไปเมื่อ ' + latest.time.slice(11, 16) + ' น. กรุณารอ 1 นาทีก่อนกดอีกครั้ง');
    }
    const values = [Utilities.getUuid(), user.email, user.name, user.department, dateKey_(now), timeText_(now),
      user.employeeId, loc.lat.toFixed(6) + ',' + loc.lng.toFixed(6), String(loc.acc), place, source];
    const sh = punchSheet_(ss);
    // Explicit text-formatted write instead of appendRow(), so Sheets cannot re-type the values.
    sh.getRange(sh.getLastRow() + 1, 1, 1, values.length).setNumberFormat('@').setValues([values]);
    SpreadsheetApp.flush();
    return dashboard_(ss, user, now);
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Location tagging ---------- */

/**
 * Validates the browser-reported position. It comes from the client, so it is a strong hint,
 * not proof: a determined user can fake GPS. Returns null when absent or malformed.
 */
function parseLocation_(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const lat = Number(loc.lat), lng = Number(loc.lng), acc = Number(loc.acc);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return {lat:lat, lng:lng, acc:isFinite(acc) && acc >= 0 ? Math.min(Math.round(acc), MAX_ACCURACY_M) : ''};
}

/**
 * Human-readable address via the built-in Maps service; empty if lookup fails or quota is used up.
 * Cached per ~11 m grid cell so the live preview and the clock call share one lookup.
 */
function placeName_(loc) {
  const cache = CacheService.getScriptCache();
  const key = 'geo:' + loc.lat.toFixed(4) + ',' + loc.lng.toFixed(4);
  const hit = cache.get(key);
  if (hit !== null) return hit;
  try {
    const res = Maps.newGeocoder().setLanguage('th').reverseGeocode(loc.lat, loc.lng);
    const place = res && res.results && res.results[0] ? String(res.results[0].formatted_address).slice(0, 300) : '';
    if (place) cache.put(key, place, 6 * 3600);
    return place;
  } catch (err) {
    console.warn('reverseGeocode failed: ' + err.message);
    return '';
  }
}

/** Address for the "current location" card shown before clocking. */
function placeView_(location) {
  const loc = parseLocation_(location);
  if (!loc) throw fail_('INPUT', 'ตำแหน่งไม่ถูกต้อง');
  return {place:placeName_(loc)};
}

function locationView_(latLng, acc, place) {
  if (!latLng) return null;
  return {latLng:latLng, accuracy:acc === '' ? null : Number(acc), place:place,
    mapUrl:'https://www.google.com/maps?q=' + encodeURIComponent(latLng)};
}

/* ---------- Google web app (google.script.run) ---------- */

function getDashboard() {
  const ss = getDb_();
  return dashboard_(ss, employee_(ss), new Date());
}

function previewPlace(location) {
  const ss = getDb_();
  employee_(ss); // employees only: keeps the Maps quota for staff
  return placeView_(location);
}

function punch(location) {
  const ss = getDb_();
  return punchFor_(ss, employee_(ss), location, 'WEB');
}

/** v1.x pages called clock('IN'|'OUT', location); both are now just a punch. */
function clock(action, location) { return punch(location); }

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
      case 'punch':
      case 'clock': // v1.x LIFF pages still cached on phones
        data = punchFor_(ss, employeeByLine_(ss, lineUserId), req.location, 'LINE'); break;
      case 'place': employeeByLine_(ss, lineUserId); data = placeView_(req.location); break;
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
  try {
    user = employeeWhere_(ss, rowEmail => sameEmail_(rowEmail, email));
    if (!user) console.warn('linkStart: no active employee matches ' + email);
  } catch (err) {
    console.warn('linkStart: employee lookup failed for ' + email + ': ' + err.message);
  }
  // Same reply whether or not the address is an employee, so it cannot be used to discover who works here.
  // The reason is only logged above, visible to the owner under Apps Script → Executions.
  if (user) {
    const code = otp_();
    // Store and mail the address as registered in the sheet, not as typed.
    cache.put('link:' + lineUserId, JSON.stringify({email:user.email, hash:sha_(code + ':' + lineUserId), tries:0}), LINK_TTL_SEC);
    MailApp.sendEmail({
      to: user.email,
      subject: 'รหัสยืนยันการเชื่อมบัญชี LINE | POLA WFH Attendance',
      body: 'รหัสยืนยันของคุณคือ ' + code + '\n\nรหัสนี้ใช้ได้ภายใน 10 นาที เพื่อเชื่อมบัญชี LINE กับระบบลงเวลาทำงาน\n' +
        'หากคุณไม่ได้ขอรหัสนี้ ไม่ต้องดำเนินการใดๆ และห้ามส่งรหัสนี้ให้ผู้อื่น'
    });
    console.log('linkStart: OTP sent to ' + user.email + ' (mail quota left today: ' + MailApp.getRemainingDailyQuota() + ')');
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

/** Pushes a LINE message to every linked employee whose only punch today is the clock-in. */
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
  const todays = {};
  allPunches_(ss).filter(p => p.date === today && p.empId).forEach(p => (todays[p.empId] = todays[p.empId] || []).push(p));
  Object.keys(todays).forEach(empId => {
    const to = lineById[empId];
    if (!to || todays[empId].length !== 1) return;
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: {Authorization: 'Bearer ' + token},
      payload: JSON.stringify({to:to, messages:[{type:'text',
        text:'⏰ วันนี้คุณลงเวลาเข้างานไว้ ' + todays[empId][0].time.slice(11, 16) + ' น. แต่ยังไม่ได้ลงเวลาออก อย่าลืมกดลงเวลาออกงานนะครับ'}]})
    });
  });
}
