const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'improved/Code.gs'), 'utf8');
const now = new Date('2026-11-05T05:00:00Z'); // noon Bangkok
const hr = {email:'hr@pola.test', employeeId:'0001', name:'HR', department:'HR'};
const employee = {email:'staff@pola.test', employeeId:'0019', name:'Staff', department:'IT'};
const headers = {
  Employees:['Email','FullName','Department','Active','EmployeeId','LineUserId'],
  Attendance:['RecordId','Email','FullName','Department','WorkDate','ClockIn','ClockOut','Status','Notes','EmployeeId'],
  Punches:['PunchId','Email','FullName','Department','WorkDate','PunchTime','EmployeeId','Location','AccuracyM','Place','Source']
};
function environment(rows = {}, emails = 'HR@pola.test', actor = hr) {
  const reads = [];
  const properties = {HR_EMAILS:emails};
  const context = vm.createContext({Date, console,
    PropertiesService:{getScriptProperties:()=>({getProperty:key=>properties[key] || null})},
    Utilities:{formatDate:(date, zone, format)=>{
      const parts = new Intl.DateTimeFormat('en-CA', {timeZone:zone, year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).formatToParts(date);
      const value = type=>parts.find(p=>p.type === type).value;
      return format.replace('yyyy',value('year')).replace('MM',value('month')).replace('dd',value('day'))
        .replace('HH',value('hour')).replace('mm',value('minute')).replace('ss',value('second'));
    }},
    ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this}})}
  });
  vm.runInContext(source, context);
  const ss = {getSheetByName:name=>{
    const values = [headers[name], ...(rows[name] || [])];
    return {getLastRow:()=>values.length,
      getRange:()=>({getValues:()=>{reads.push(name);return values.slice(1)}}),
      getDataRange:()=>({getDisplayValues:()=>{reads.push(name);return values.map(row=>row.map(String))}})};
  }};
  context.getDb_ = ()=>ss;
  context.employee_ = ()=>actor;
  context.employeeByLine_ = ()=>actor;
  context.verifyLineToken_ = token=>{if(token !== 'verified') throw context.fail_('AUTH','invalid token');return 'line-user'};
  return {context, ss, reads, properties};
}
function punch(id, time, email='staff@pola.test', empId='0019') {
  return [id,email,'Staff','IT','1999-01-01',time,empId,'13.7,100.5','15','Office','LINE'];
}
function report(env, date) { return env.context.hrAttendance_(env.ss, hr, date, now); }

test('HR defaults to Bangkok current date and summarizes first/last with lunch deduction', ()=>{
  const env = environment({Punches:[punch('1','2026-11-05 08:00:00'),punch('2','2026-11-05 10:00:00'),punch('3','2026-11-05 12:00:00')]});
  const data = report(env);
  assert.equal(data.date, '2026-11-05');
  assert.equal(data.employeeCount,1);
  assert.equal(data.punchCount,3);
  assert.equal(data.rows[0].clockIn,'2026-11-05 08:00:00');
  assert.equal(data.rows[0].clockOut,'2026-11-05 12:00:00');
  assert.equal(data.rows[0].hours,4);
  assert.equal(data.rows[0].punches[0].location.mapUrl,'https://www.google.com/maps?q=13.7%2C100.5');
  const earlier = environment({Punches:[punch('1','2026-11-04 08:00:00'),punch('2','2026-11-04 17:00:00')]});
  assert.equal(report(earlier,'2026-11-04').rows[0].hours,8);
});

test('unauthorized HR request is rejected before reading employee attendance', ()=>{
  const env=environment({},'');
  assert.throws(()=>report(env),error=>error.code==='FORBIDDEN');
  assert.deepEqual(env.reads,[]);
  const denied=environment({},'hr@pola.test',employee);
  const result=JSON.parse(denied.context.doPost({postData:{contents:JSON.stringify({action:'hrAttendance',idToken:'verified',email:hr.email,isHr:true})}}).text);
  assert.equal(result.code,'FORBIDDEN');
  assert.deepEqual(denied.reads,[]);
});

test('LINE route authenticates token and Google route checks HR role', ()=>{
  const env=environment();
  const invoke=body=>JSON.parse(env.context.doPost({postData:{contents:JSON.stringify(body)}}).text);
  assert.equal(invoke({action:'hrAttendance',idToken:'bad'}).code,'AUTH');
  assert.equal(invoke({action:'hrAttendance',idToken:'verified',date:'2026-11-04'}).ok,true);
  assert.equal(env.context.getHrAttendance('2026-11-04').date,'2026-11-04');
  env.properties.HR_EMAILS='';
  assert.throws(()=>env.context.getHrAttendance('2026-11-04'),error=>error.code==='FORBIDDEN');
});

test('server rejects invalid dates, impossible dates and future dates', ()=>{
  const env=environment();
  for(const date of ['2026-02-30','2026-11-06','05-11-2026','2026-1-1',{},['2026-11-05']]) {
    assert.throws(()=>report(env,date),error=>error.code==='INPUT');
  }
});

test('daily filtering uses actual timestamp, excludes future punches and handles midnight', ()=>{
  const env=environment({Punches:[punch('1','2026-11-04 23:59:00'),punch('2','2026-11-05 00:01:00'),punch('3','2026-11-05 12:00:01')]});
  assert.equal(report(env).punchCount,1);
  assert.equal(report(env).rows[0].status,'IN');
  assert.equal(report(env,'2026-11-04').rows[0].status,'MISSED_OUT');
});

test('legacy records without IDs merge with punches by roster, including inactive employees', ()=>{
  const env=environment({Employees:[['staff@pola.test','Former staff','Sales',false,'0019','private-line-id']],
    Attendance:[['old','staff@pola.test','Staff','IT','2026-11-04','2026-11-04 08:00:00','2026-11-04 17:00:00','','','']],
    Punches:[punch('copy','2026-11-04 08:00:00'),punch('midday','2026-11-04 12:00:00')]});
  const data=report(env,'2026-11-04');
  assert.equal(data.employeeCount,1);
  assert.equal(data.rows[0].employeeId,'0019');
  assert.equal(data.rows[0].name,'Former staff');
  assert.equal(data.punchCount,3);
  assert.equal(data.rows[0].hours,8);
  assert.ok(!JSON.stringify(data).includes('private-line-id'));
});

test('empty dates, unmapped legacy rows and stable employee ordering', ()=>{
  const env=environment({Punches:[punch('2','2026-11-05 08:00:00','b@pola.test','0024'),punch('1','2026-11-05 09:00:00')],
    Attendance:[['old','old@pola.test','Old name','Old department','2026-11-04','2026-11-04 08:00:00','','','','']]});
  assert.equal(report(env).rows[0].employeeId,'0019');
  assert.equal(report(env,'2026-11-04').rows[0].name,'Old name');
  assert.equal(report(env,'2026-11-03').rows.length,0);
});

test('dashboard exposes only HR capability, never the HR allowlist or other staff records', ()=>{
  const env=environment();
  assert.equal(env.context.dashboard_(env.ss,hr,now).user.isHr,true);
  assert.equal(env.context.dashboard_(env.ss,employee,now).user.isHr,false);
  assert.ok(!JSON.stringify(env.context.dashboard_(env.ss,employee,now)).includes(hr.email));
});

test('both inline browser scripts parse successfully and contain the same shared HR behavior', ()=>{
  const shared=[];
  for(const name of ['docs/index.html','improved/Index.html']) {
    const html=fs.readFileSync(path.join(root,name),'utf8');
    for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    const section=html.split('/* ---------- HR daily review ---------- */')[1].split('/* ---------- End HR daily review ---------- */')[0];
    shared.push(section.replace(/function requestHr\(date\)\{[^\n]*\}/,''));
    assert.ok(html.includes('syncHrAccess(data)'));
    assert.ok(html.includes('id="hrPanel" class="card hr-panel" role="tabpanel"'));
    assert.ok(html.includes('id="tabHr" class="app-tab"'));
  }
  assert.equal(shared[0],shared[1]);
});
