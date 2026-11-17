'use strict';
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { check, section } = require('./harness');

async function run() {
  section('SEC-01 actual legacy router wiring (isolated services)');
  const previousSecret=process.env.CASHFLOW_JWT_SECRET;
  process.env.CASHFLOW_JWT_SECRET='sec01-synthetic-secret';
  const saved=new Map();
  const payloadCalls=[];
  const authQueries=[];
  let grant='View';
  let dbFails=false;
  function replace(file,exports) {
    const name=require.resolve(file);
    saved.set(name,require.cache[name]);
    require.cache[name]={id:name,filename:name,loaded:true,exports};
  }
  const controllers={};
  for(const name of ['chat','analyzeTransactions','clearHistory','checkHistorySize','clearSessionById','repairSession','getChatHistory','autoCategorizeTransaction','invalidateAutoCategorizationKey','summarization']) {
    controllers[name]=(req,res)=>{payloadCalls.push({name,actor:req.cashflowUser?.id});res.json({success:true,handler:name,actor:req.cashflowUser?.id});};
  }
  replace('../controllers/openaiController',controllers);
  replace('../services/db',{query:async(sql,args)=>{
    authQueries.push(sql);
    if(dbFails) throw new Error('synthetic database outage');
    if(sql.includes('user_sessions')) return args[0]==='revoked'?[]:[{id:args[0]}];
    if(sql.includes('FROM accounts')) return String(args[0])==='10'?[{accountid:10,userid:1,satelite_id:8}]:[];
    if(sql.includes('FROM satelite')) return String(args[1])==='2'?[{satelite_id:8,owner_id:1,satelite_user_id:2,permission_level:grant}]:[];
    throw new Error('Unexpected query');
  }});
  replace('../services/accounts.service',{getAccountsByUserIdPaginated:async(...args)=>{
    payloadCalls.push({name:'accounts',args});return {accounts:[{accountid:10,access_token:'fixture-bank-secret',processor_token:'fixture-processor-secret',disabled_access_token:'fixture-disabled-secret',balance:15}],pagination:{page:2,total:3}};
  }});
  const data={};
  for(const [fn,name] of [['getTransactionsByUserAndAccountPaginated','transactions'],['getRecurringForecastsByAccountPaginated','forecasts'],['getTransactionSummary','summary']]) {
    data[fn]=async(...args)=>{payloadCalls.push({name,args});return {fixture:name,args};};
  }
  replace('../services/transactions.service',data);
  const routeFile=require.resolve('../routes/openaiRoutes');
  saved.set(routeFile,require.cache[routeFile]);delete require.cache[routeFile];
  const app=express();app.use(express.json());
  app.use('/api/agent',require('../routes/openaiRoutes'));
  const server=http.createServer(app);
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=server.address().port;
    function token(actor=1,extra={},secret=process.env.CASHFLOW_JWT_SECRET) {
      return jwt.sign({id:actor,jti:`fixture-session-${actor}`,...extra},secret,{expiresIn:'5m'});
    }
    function request(method,path,{actor=1,body={},headers={},auth=true,rawToken}={}) {
      const encoded=JSON.stringify(body);
      return new Promise((resolve,reject)=>{
        const req=http.request({host:'127.0.0.1',port,method,path:'/api/agent'+path,headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(encoded),...(auth?{Authorization:'Bearer '+(rawToken||token(actor))}:{}),...headers}},res=>{
          let value='';res.on('data',c=>value+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(value)}));
        });req.on('error',reject);req.end(encoded);
      });
    }
    const protectedRoutes=[['GET','/accounts/1'],['GET','/transactions/1/10'],['GET','/forecasts/10'],['GET','/summary/1/10'],['POST','/chat-history'],['DELETE','/clear-history'],['GET','/check-history-size'],['DELETE','/clear-session/1'],['POST','/repair-session'],['POST','/summarize'],['POST','/summarization']];
    for(const [method,path] of protectedRoutes) {
      payloadCalls.length=0;authQueries.length=0;
      const r=await request(method,path,{auth:false});
      check(`${method} ${path} unauthenticated 401 before any data/auth-store call`,r.status===401 && payloadCalls.length===0 && authQueries.length===0);
    }
    for(const [name,t] of [['forged',token(1,{},'wrong')],['setup',token(1,{setup:true})],['share',token(1,{share:'sharelink'})],['revoked',token(1,{jti:'revoked'})]]) {
      payloadCalls.length=0;
      const r=await request('GET','/transactions/1/10',{rawToken:t});
      check(name+' token denied before payload',r.status===401 && payloadCalls.length===0);
    }
    let r=await request('GET','/accounts/1?page=2&limit=3');
    check('owner listing preserves envelope/pagination without credentials',r.status===200 && r.body.success && r.body.data.pagination.page===2 && ['access_token','processor_token','disabled_access_token'].every(k=>!Object.prototype.hasOwnProperty.call(r.body.data.accounts[0],k)));
    check('listing query arguments unchanged',JSON.stringify(payloadCalls[payloadCalls.length-1].args)==='["1",2,3]');
    payloadCalls.length=0;r=await request('GET','/accounts/1',{actor:2});
    check('satellite cannot list owner other accounts',r.status===403 && payloadCalls.length===0);
    for(const selector of [1,2]) {
      r=await request('GET',`/transactions/${selector}/10?page=2&limit=7&startDate=2026-01-01&endDate=2026-01-31`,{actor:2});
      check('permitted satellite selector '+selector,r.status===200 && r.body.data.args[0]===String(selector) && r.body.data.args[2].limit===7 && r.body.data.args[2].startDate==='2026-01-01');
    }
    for(const [path,actor] of [['/transactions/99/10',2],['/transactions/3/10',3],['/transactions/1/99',1],['/forecasts/10',2]]) {
      payloadCalls.length=0;r=await request('GET',path,{actor});
      check('scope/capability denial '+path+' actor '+actor,r.status===403 && payloadCalls.length===0);
    }
    grant='Forecast';r=await request('GET','/forecasts/10',{actor:2});
    check('Forecast grant succeeds',r.status===200 && r.body.data.fixture==='forecasts');
    grant='View';r=await request('GET','/summary/1/10',{actor:2});
    check('View grant reads transaction aggregates',r.status===200 && r.body.data.fixture==='summary');
    dbFails=true;payloadCalls.length=0;r=await request('GET','/forecasts/10');
    check('account authorization outage fails closed 503',r.status===503 && payloadCalls.length===0 && !JSON.stringify(r.body).includes('synthetic database'));
    dbFails=false;
    for(const [method,path] of protectedRoutes.slice(4)) {
      payloadCalls.length=0;r=await request(method,path);
      check('self history/writer allowed '+path,r.status===200 && payloadCalls.length===1 && payloadCalls[0].actor===1);
      if(!path.startsWith('/clear-session')) {
        payloadCalls.length=0;r=await request(method,path,{body:{sessionId:2}});
        check('body spoof denied '+path,r.status===403 && payloadCalls.length===0);
      }
    }
    for(const options of [{body:{userId:2}},{headers:{'x-user-id':'2'}},{headers:{'x-session-id':'2'}},{body:{sessionId:['1']}},{body:{sessionId:{id:1}}}]) {
      payloadCalls.length=0;r=await request('POST','/chat-history',options);
      check('history selector injection denied '+JSON.stringify(options),r.status===403 && payloadCalls.length===0);
    }
    for(const path of ['/chat-history?sessionId=2','/chat-history?userId=2','/chat-history?sessionId=1&sessionId=2']) {
      payloadCalls.length=0;r=await request('POST',path);
      check('query spoof denied '+path,r.status===403 && payloadCalls.length===0);
    }
    payloadCalls.length=0;r=await request('DELETE','/clear-session/2');
    check('explicit cross-user deletion denied',r.status===403 && payloadCalls.length===0);
    r=await request('POST','/chat-history',{auth:false,body:{token:token(),sessionId:1}});
    check('existing body-token transport preserved',r.status===200);
    r=await request('DELETE','/clear-history?sessionId=1&token=ignored');
    check('frontend bearer DELETE query selectors preserved',r.status===200);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    for(const [name,value] of saved) {if(value)require.cache[name]=value;else delete require.cache[name];}
    if(previousSecret===undefined)delete process.env.CASHFLOW_JWT_SECRET;else process.env.CASHFLOW_JWT_SECRET=previousSecret;
  }
}
module.exports={run};
