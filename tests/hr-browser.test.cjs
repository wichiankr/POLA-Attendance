// Optional real-browser smoke test. Uses fixtures only; never calls production APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const browser = process.env.BROWSER_BIN || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(file=>fs.existsSync(file));

async function connectBrowser(directory) {
  const process=spawn(browser,['--headless','--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-extensions','--remote-debugging-port=0',
    `--user-data-dir=${path.join(directory,'profile')}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
  try {
    const endpoint=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Browser startup timed out')),10000);
      let output='';
      process.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/\S+)/);
        if(match){clearTimeout(timeout);resolve(match[1])}});
      process.on('error',error=>{clearTimeout(timeout);reject(error)});
    });
    const socket=new WebSocket(endpoint);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
    let sequence=0;const pending=new Map();
    socket.onmessage=event=>{const message=JSON.parse(event.data);const request=pending.get(message.id);
      if(request){pending.delete(message.id);clearTimeout(request.timeout);message.error?request.reject(new Error(message.error.message)):request.resolve(message.result)}};
    const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
      const id=++sequence;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method))},15000);
      pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params,sessionId}));
    });
    return {call,close(){socket.close();process.kill()}};
  } catch(error) {process.kill();throw error}
}

test('HR browser: default date, navigation, empty/error states, races, escaping and access removal',
  {skip:!browser,timeout:60000}, async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pola-hr-preview-'));
  const filename=path.join(directory,'preview.html');
  let html=fs.readFileSync(path.join(__dirname,'../docs/index.html'),'utf8').replace(/\r\n/g,'\n');
  html=html.replace(/<script[^>]+src=[^>]*><\/script>/g,'');
  const fixture=String.raw`
(async()=>{
try{
  const data={user:{name:'HR preview',email:'hr@example.test',department:'HR',employeeId:'0001',isHr:true},today:'2026-11-05',serverEpoch:Date.now(),status:'NOT_STARTED',punchCount:0,history:[],punchesToday:[]};
  const sample={date:data.today,today:data.today,employeeCount:2,punchCount:3,rows:[
    {employeeId:'0019',name:'พนักงานทดสอบ หนึ่ง',department:'ฝ่ายขาย',clockIn:'2026-11-05 08:30:00',clockOut:'2026-11-05 17:30:00',hours:8,status:'COMPLETED',punchCount:2,punches:[{time:'2026-11-05 08:30:00',location:{place:'สถานที่ทดสอบ',latLng:'13.7,100.5',mapUrl:'https://www.google.com/maps?q=13.7,100.5'}},{time:'2026-11-05 17:30:00',location:null}]},
    {employeeId:'0024',name:'<img src=x onerror=alert(1)>',department:'IT',clockIn:'2026-11-05 09:00:00',clockOut:'',hours:null,status:'IN',punchCount:1,punches:[{time:'2026-11-05 09:00:00',location:null}]}
  ]};
  const assert=(condition,message)=>{if(!condition)throw new Error(message)};
  syncHere=()=>{};load=async()=>{};
  requestHr=async date=>date===data.today?sample:{date,today:data.today,employeeCount:0,punchCount:0,rows:[]};
  render(data);assert(!$('hrPanel').hidden,'HR access');assert($('hrDate').value===data.today,'default date');
  $('hrPanel').open=true;await loadHr();assert($('hrRecords').children.length===2,'rows');
  assert(!$('hrRecords').querySelector('img'),'safe text rendering');
  $('hrPrevious').click();await Promise.resolve();await Promise.resolve();
  assert($('hrDate').value==='2026-11-04','previous day');assert($('hrStatus').textContent.includes('0 คน'),'empty date');
  $('hrToday').click();await Promise.resolve();await Promise.resolve();assert($('hrNext').disabled,'no future day');
  const callbacks={};requestHr=date=>new Promise(resolve=>callbacks[date]=resolve);
  $('hrDate').value='2026-11-03';const old=loadHr();$('hrDate').value='2026-11-04';const current=loadHr();
  callbacks['2026-11-04']({date:'2026-11-04',today:data.today,employeeCount:0,punchCount:0,rows:[]});await current;
  callbacks['2026-11-03']({...sample,date:'2026-11-03'});await old;assert(hrLoadedDate==='2026-11-04','ignore stale response');
  requestHr=async()=>{throw new Error('test failure')};await loadHr();assert($('hrRecords').children.length===0,'clear stale rows on failure');assert($('hrStatus').textContent.includes('test failure'),'error message');
  data.user.isHr=false;syncHrAccess(data);assert($('hrPanel').hidden,'deny ordinary user');assert(!$('hrRecords').children.length,'clear HR data');
  data.user.isHr=true;render(data);requestHr=async()=>sample;$('hrDate').value=data.today;$('hrPanel').open=true;await loadHr();
  assert(document.documentElement.scrollWidth<=innerWidth,'no page overflow');
  document.body.dataset.hrChecks='passed';location.hash='hrPanel';
}catch(error){document.body.dataset.hrChecks='failed';document.body.dataset.hrError=error.message}
})();`;
  assert.ok(html.includes('boot();\n</script>'));
  html=html.replace('boot();\n</script>',fixture+'\n</script>');
  fs.writeFileSync(filename,html);
  const connection=await connectBrowser(directory);
  try {
    const {targetId}=await connection.call('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await connection.call('Target.attachToTarget',{targetId,flatten:true});
    for(const width of [1100,390]) {
      await connection.call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:width<500},sessionId);
      await connection.call('Page.navigate',{url:pathToFileURL(filename).href},sessionId);
      const result=await connection.call('Runtime.evaluate',{expression:`new Promise((resolve,reject)=>{
        const deadline=Date.now()+10000;const timer=setInterval(()=>{
          if(document.body?.dataset.hrChecks){clearInterval(timer);resolve({status:document.body.dataset.hrChecks,error:document.body.dataset.hrError,width:innerWidth})}
          else if(Date.now()>deadline){clearInterval(timer);reject(new Error('Fixture timed out'))}
        },20)})`,awaitPromise:true,returnByValue:true},sessionId);
      assert.ok(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));
      assert.equal(result.result.value.status,'passed',result.result.value.error);
      assert.equal(result.result.value.width,width,'actual CSS viewport width');
      const screenshot=await connection.call('Page.captureScreenshot',{format:'png'},sessionId);
      const output=path.join(directory,`hr-${width}.png`);fs.writeFileSync(output,Buffer.from(screenshot.data,'base64'));
      console.log('HR preview screenshot:',output);
    }
  } finally {
    connection.close();
  }
});
