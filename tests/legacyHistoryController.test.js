'use strict';
const { check, section }=require('./harness');

async function run() {
  section('SEC-01 real history controllers with in-memory boundaries');
  const saved=new Map();
  const calls=[];
  const state=new Map();
  function replace(file,exports) {
    const name=require.resolve(file);saved.set(name,require.cache[name]);
    require.cache[name]={id:name,filename:name,loaded:true,exports};
  }
  const redis={
    get:async key=>{calls.push(['get',key]);return state.get(key)||null;},
    set:async(key,value,...rest)=>{calls.push(['set',key,...rest]);state.set(key,value);return 'OK';},
    del:async key=>{calls.push(['del',key]);return state.delete(key)?1:0;},
  };
  replace('../services/redisService',redis);
  replace('../services/db',{query:async()=>{throw new Error('Unexpected database query in history test');}});
  replace('../services/openaiService',{queryAzureOpenAI:async()=>({choices:[{message:{content:'Synthetic summary'}}]}),functionSchemas:[],filterFunctionSchemas:()=>[]});
  replace('../tools/functionMap',{functionMap:{}});
  replace('../services/contextCache.service',{});
  const controllerFile=require.resolve('../controllers/openaiController');
  saved.set(controllerFile,require.cache[controllerFile]);delete require.cache[controllerFile];
  const controller=require('../controllers/openaiController');
  const oldLog=console.log;
  const logs=[];console.log=(...args)=>logs.push(args.map(String).join(' '));
  const req=(overrides={})=>({cashflowUser:{id:1},body:{},query:{},params:{},headers:{authorization:'Bearer fixture-secret'},...overrides});
  const response=()=>({statusCode:200,status(c){this.statusCode=c;return this;},json(body){this.body=body;return this;}});
  try {
    state.set('session:1',JSON.stringify([{role:'system',content:'private context'},{role:'user',content:'Hello'},{role:'assistant',content:'Hi'}]));
    state.set('session:2','OTHER USER HISTORY');
    let res=response();await controller.getChatHistory(req({body:{sessionId:2}}),res);
    check('history derives verified user despite raw selector',res.body.sessionKey==='session:1' && res.body.messageCount===2 && res.body.history[0].content==='Hello');
    check('history never reads another bucket',calls.every(c=>c[1]!=='session:2'));
    res=response();await controller.checkHistorySize(req(),res);
    check('size uses self key',res.statusCode===200 && calls[calls.length-1][1]==='session:1');
    state.set('session:1',JSON.stringify([{role:'user',content:'Hello'},{role:'assistant',content:''}]));
    res=response();await controller.repairSession(req(),res);
    check('repair succeeds with self history',res.statusCode===200 && res.body.sessionKey==='session:1');
    calls.length=0;
    res=response();await controller.clearHistory(req(),res);
    const deleted=calls.filter(c=>c[0]==='del').map(c=>c[1]);
    check('clear deletes own session and transient dialogue/summary',res.statusCode===200 && deleted.includes('session:1') && deleted.some(k=>k.includes('dialogue') && k.endsWith(':1')) && deleted.some(k=>k.includes('summary') && k.endsWith(':1')));
    check('clear never calls durable memory backend or other user',state.get('session:2')==='OTHER USER HISTORY' && deleted.every(k=>k.endsWith(':1')));
    check('clear logs exclude credentials',!logs.join('\n').includes('fixture-secret'));
    state.set('session:1','[]');calls.length=0;
    res=response();await controller.clearSessionById(req({params:{sessionId:'001'}}),res);
    check('explicit-session controller derives verified key',res.statusCode===200 && calls[0][1]==='session:1' && state.has('session:2'));
    calls.length=0;res=response();
    await controller.analyzeTransactions(req({body:{transactions:[],userData:{},sessionId:2}}),res);
    check('summarize writes verified history only',res.statusCode===200 && calls.some(c=>c[0]==='set' && c[1]==='session:1') && calls.every(c=>c[1]!=='session:2'));
    const historyBefore=state.get('session:1');
    calls.length=0;res=response();
    await controller.summarization(req({body:{accountSnapshot:{accountid:10,balance:100},userData:{},clientDate:'2026-11-17'}}),res);
    check('summarization succeeds without mutating conversation history',res.statusCode===200 && state.get('session:1')===historyBefore && !calls.some(c=>c[0]==='set' && c[1]==='session:1'));
    check('summarization cache is scoped to verified actor',calls.some(c=>c[0]==='set' && c[1].includes('session:1')) && calls.every(c=>!c[1].includes('session:2')));
  } finally {
    console.log=oldLog;
    for(const [name,value]of saved){if(value)require.cache[name]=value;else delete require.cache[name];}
  }
}
module.exports={run};
