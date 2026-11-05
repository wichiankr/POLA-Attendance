const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function clock(){
  const timers=new Map();let id=0;
  return {timers,setTimeout(fn,ms){timers.set(++id,{fn,ms});return id},clearTimeout(id){timers.delete(id)},
    fire(ms){for(const [key,timer] of timers){if(timer.ms===ms){timers.delete(key);timer.fn()}}}};
}
function liffEnvironment(fetch){
  const html=fs.readFileSync(path.join(__dirname,'../docs/index.html'),'utf8');
  const source=html.split('class ApiError extends Error')[1].split('function handleAuth')[0];
  const timer=clock();
  const context=vm.createContext({...timer,AbortController,fetch,CFG:{API_URL:'https://example.test/api',LIFF_ID:'test'},
    liff:{getIDToken:()=> 'test-token',init:()=>Promise.resolve()}});
  vm.runInContext('class ApiError extends Error'+source,context);
  return {context,timer};
}

test('LIFF API timeout cancels fetch without retrying',async()=>{
  let calls=0;
  const {context,timer}=liffEnvironment((url,options)=>{
    calls++;
    return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted'))));
  });
  const result=context.api('dashboard');
  timer.fire(30000);
  await assert.rejects(result,error=>error.code==='TIMEOUT');
  assert.equal(calls,1);
  assert.equal(timer.timers.size,0);
});

test('LIFF timeout includes pending response body and warns about uncertain punch result',async()=>{
  let bodyStarted;const ready=new Promise(resolve=>bodyStarted=resolve);
  const {context,timer}=liffEnvironment(async(url,options)=>({json:()=>new Promise((resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(new Error('body aborted')));bodyStarted();
  })}));
  const result=context.api('punch');
  await ready;
  timer.fire(30000);
  await assert.rejects(result,error=>error.code==='TIMEOUT'&&error.message.includes('รายการอาจบันทึกแล้ว'));
});

test('successful and rejected API responses clear their timeout',async()=>{
  let result={ok:true,data:{today:'2026-11-05'}};
  const {context,timer}=liffEnvironment(async()=>({json:async()=>result}));
  assert.equal((await context.api('dashboard')).today,'2026-11-05');
  assert.equal(timer.timers.size,0);
  result={ok:false,code:'FORBIDDEN',error:'denied'};
  await assert.rejects(context.api('hrAttendance'),error=>error.code==='FORBIDDEN');
  assert.equal(timer.timers.size,0);
});

test('LIFF initialization has its own deadline',async()=>{
  const {context,timer}=liffEnvironment(()=>{});
  context.liff.init=()=>new Promise(()=>{});
  const result=context.initLiff();
  timer.fire(20000);
  await assert.rejects(result,error=>error.code==='TIMEOUT');
});

test('Google script timeout releases UI and ignores late callback',async()=>{
  const html=fs.readFileSync(path.join(__dirname,'../improved/Index.html'),'utf8');
  const source=html.slice(html.indexOf('function googleRequest('),html.indexOf('async function load(){'));
  const timer=clock();let success;let callbacks=0;
  const runner={withSuccessHandler(fn){success=fn;return this},withFailureHandler(){return this},getDashboard(){}};
  const context=vm.createContext({...timer,google:{script:{run:runner}}});
  vm.runInContext(source,context);
  const result=context.googleRequest('getDashboard').then(()=>{callbacks++;return 'success'},error=>{callbacks++;return error.message});
  timer.fire(30000);
  assert.ok((await result).includes('30'));
  success({today:'2026-11-05'});
  await Promise.resolve();
  assert.equal(callbacks,1);
  assert.equal(timer.timers.size,0);
});
