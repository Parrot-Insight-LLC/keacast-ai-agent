'use strict';
const jwt=require('jsonwebtoken');
const http=require('http');
const express=require('express');
const {check,section}=require('./harness');
const {cashflowAuth}=require('../middleware/cashflowAuth');
const {assertActiveCashflowSession}=require('../services/cashflowSessionAuthorization');

async function run() {
  section('SEC-02 fresh sensitive-operation session fault matrix');
  const previous=process.env.CASHFLOW_JWT_SECRET;
  const previousTimeout=process.env.KEA_AUTH_DB_TIMEOUT_MS;
  process.env.CASHFLOW_JWT_SECRET='sec02-fixture-secret';
  process.env.KEA_AUTH_DB_TIMEOUT_MS='1000';
  const sign=(extra={},options={})=>jwt.sign({id:7,jti:'session-7',...extra},process.env.CASHFLOW_JWT_SECRET,{expiresIn:'5m',...options});
  const token=sign();
  const active=async(_sql,args)=>[{id:args[0]}];
  async function failure(name,requestToken,actor,query,code,options={}) {
    let error;
    try {await assertActiveCashflowSession(requestToken,actor,{queryFn:query,dbTimeoutMs:15,...options});}
    catch(e){error=e;}
    check(name,error?.code===code);
  }
  const saved=new Map();
  const backendCalls=[];
  const metadataCalls=[];
  let mode='active';
  function replace(file,exports){const name=require.resolve(file);saved.set(name,require.cache[name]);require.cache[name]={id:name,filename:name,loaded:true,exports};}
  const query=async(sql,args)=>{
    metadataCalls.push({sql,args});
    if(mode==='throw')throw new Error('SYNTHETIC_DB_PRIVATE_DETAIL');
    if(mode==='hang')return new Promise(()=>{});
    if(mode==='revoked')return [];
    return [{id:args[0]}];
  };
  try {
    // Load the real controller against its original dependencies before stubbing
    // the backend layer for isolated real-executor tests below.
    const {__testables:T}=require('../controllers/openaiController');
    const verified=await assertActiveCashflowSession(token,7,{queryFn:active});
    check('active actor-bound JTI accepted',verified.id===7 && verified.jti==='session-7');
    for(const [name,requestToken,actor,fn,code]of[
      ['missing JTI',sign({jti:undefined}),7,active,'SESSION_REQUIRED'],
      ['blank JTI',sign({jti:' '}),7,active,'SESSION_REQUIRED'],
      ['wrong actor',token,8,active,'SESSION_ACTOR_MISMATCH'],
      ['setup token',sign({setup:true}),7,active,'TOKEN_WRONG_KIND'],
      ['share token',sign({share:true}),7,active,'TOKEN_WRONG_KIND'],
      ['satellite link token',sign({sat:true}),7,active,'TOKEN_WRONG_KIND'],
      ['wrong algorithm',sign({}, {algorithm:'HS384'}),7,active,'TOKEN_INVALID'],
      ['expired after model delay',sign({}, {expiresIn:-1}),7,active,'TOKEN_INVALID'],
      ['revoked or unknown',token,7,async()=>[],'SESSION_REVOKED'],
      ['malformed store response',token,7,async()=>({length:1}),'SESSION_REVOKED'],
      ['mismatched store row',token,7,async()=>[{id:'other-session'}],'SESSION_REVOKED'],
      ['store rejection',token,7,async()=>{throw new Error('PRIVATE');},'SESSION_CHECK_UNAVAILABLE'],
      ['hung lookup',token,7,()=>new Promise(()=>{}),'SESSION_CHECK_UNAVAILABLE'],
    ])await failure(name,requestToken,actor,fn,code);
    let resolveLate;
    await failure('late lookup cannot retroactively authorize',token,7,()=>new Promise(resolve=>{resolveLate=resolve;}),'SESSION_CHECK_UNAVAILABLE');
    resolveLate([{id:'session-7'}]);
    const res=()=>({statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}});
    for(const kind of ['revoked','throw','hang']) {
      let called=false;
      const reply=res();
      await cashflowAuth({requireActiveSession:true,queryFn:kind==='revoked'?async()=>[]:kind==='throw'?async()=>{throw new Error('PRIVATE');}:()=>new Promise(()=>{}),dbTimeoutMs:15})({headers:{authorization:'Bearer '+token},body:{}},reply,()=>called=true);
      check('strict ingress '+kind+' never reaches handler',!called && reply.statusCode===(kind==='revoked'?401:503) && !JSON.stringify(reply.body).includes('PRIVATE'));
    }
    replace('../services/db',{query});
    const methods=['createTransaction','updateTransaction','deleteTransaction','createGoal','updateGoal','deleteGoal','rememberFact'];
    const layer={};
    for(const name of methods)layer[name]=async()=>{backendCalls.push(name);return {transaction_id:100,transactionid:100,goalid:1,title:'Fixture',target_amount:100,updatedAt:'2026-11-17'};};
    layer.deleteGroupTransactions=async()=>{backendCalls.push('deleteTransaction');return {deleted:true};};
    layer.getTransactionById=async()=>{backendCalls.push('read-transaction');return [{transactionid:100,accountid:10,forecast_type:'F',type:'expense',amount:-10}];};
    layer.getGoal=async()=>{backendCalls.push('read-goal');return {goalid:1,accountid:10,updatedAt:'2026-11-17'};};
    replace('../tools/keacast_tool_layer',layer);
    const mapFile=require.resolve('../tools/functionMap');saved.set(mapFile,require.cache[mapFile]);delete require.cache[mapFile];
    const {functionMap}=require('../tools/functionMap');
    const args={transaction_id:100,transactionid:100,goalid:1,mem_key:'fixture',mem_value:'synthetic',title:'Fixture',amount:-10,type:'expense',start:'2026-11-17',frequency:'7',category:'Uncategorized',target_amount:100,start_date:'2026-11-17',end_date:'2027-01-01'};
    const ctx={userId:7,token,accountId:10,currentDate:'2026-11-17',categoryNames:['Uncategorized']};
    for(const name of methods) {
      for(const fault of ['revoked','throw']) {
        mode=fault;backendCalls.length=0;
        let error;try{await functionMap[name]({...args,verified:true,sessionVerified:true},ctx);}catch(e){error=e;}
        check(name+' '+fault+' blocks all backend work despite injected flags',backendCalls.length===0 && error?.code===(fault==='revoked'?'SESSION_REVOKED':'SESSION_CHECK_UNAVAILABLE'));
      }
      mode='active';backendCalls.length=0;
      const result=await functionMap[name](args,ctx);
      check(name+' active session executor runs exactly once',!!result && backendCalls.filter(item=>item===name).length===1);
    }
    mode='active';backendCalls.length=0;metadataCalls.length=0;
    await functionMap.rememberFact(args,ctx);
    mode='revoked';let revoked;
    try{await functionMap.rememberFact(args,ctx);}catch(e){revoked=e;}
    check('revocation between mutations is rechecked, not cached',backendCalls.filter(n=>n==='rememberFact').length===1 && metadataCalls.length===2 && revoked?.code==='SESSION_REVOKED');
    mode='hang';backendCalls.length=0;let hung;
    const started=Date.now();
    try{await functionMap.rememberFact(args,ctx);}catch(e){hung=e;}
    check('real dispatch timeout bounded and cannot commit',hung?.code==='SESSION_CHECK_UNAVAILABLE' && backendCalls.length===0 && Date.now()-started<2000);
    check('session lookup parameters bound to verified actor',metadataCalls.every(call=>call.args[0]==='session-7' && call.args[1]===7 && call.sql.includes('revoked_at IS NULL')));
    mode='active';let ingressAccepted=false;
    await cashflowAuth({queryFn:query})({headers:{authorization:'Bearer '+token},body:{}},res(),()=>ingressAccepted=true);
    mode='revoked';backendCalls.length=0;
    const state=T.emptyDialogueState();state.draftTransaction={title:'Fixture',amount:10,type:'expense',start:'2026-11-17',frequency:7,category:'Uncategorized'};state.pendingConfirmation=true;
    const result=await T.executeToolCalls([{role:'user',content:'Yes'}],[{id:'delayed-create',function:{name:'createTransaction',arguments:JSON.stringify(state.draftTransaction)}}],{
      ...ctx,dialogueState:state,pendingConfirmationAtStart:true,draftCompleteAtStart:true,userAffirmative:true,functionMap,
      queryAzureOpenAI:async()=>({choices:[{message:{content:'The operation was not authorized.'}}]}),
    });
    check('revocation after accepted ingress prevents actual controller commit',ingressAccepted && backendCalls.length===0 && result.writes.length===0 && result.writeResponseMode==='none');
    check('denial preserves draft without false commit',state.committed!==true && state.draftTransaction.title==='Fixture' && !/^Added /.test(result.content));

    let handlerCalls=0;
    const controllerStub={};
    for(const name of ['chat','analyzeTransactions','clearHistory','checkHistorySize','clearSessionById','repairSession','getChatHistory','autoCategorizeTransaction','invalidateAutoCategorizationKey','summarization'])controllerStub[name]=(_req,reply)=>{handlerCalls++;reply.json({success:true});};
    replace('../controllers/openaiController',controllerStub);
    const routeFile=require.resolve('../routes/openaiRoutes');saved.set(routeFile,require.cache[routeFile]);delete require.cache[routeFile];
    const app=express();app.use(express.json());app.use('/api/agent',require('../routes/openaiRoutes'));
    const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      for(const[method,path]of[['DELETE','/clear-history'],['DELETE','/clear-session/7'],['POST','/repair-session']]) {
        for(const[fault,requestToken,status]of[['active',sign({jti:undefined}),401],['revoked',token,401],['throw',token,503],['active',token,200]]) {
          mode=fault;handlerCalls=0;
          const response=await new Promise((resolve,reject)=>{
            const request=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/agent'+path,method,headers:{Authorization:'Bearer '+requestToken}},reply=>{reply.resume();reply.on('end',()=>resolve(reply.statusCode));});request.on('error',reject);request.end();
          });
          check(path+' strict route '+fault+' '+status,response===status && handlerCalls===(status===200?1:0));
        }
      }
    }finally{await new Promise(resolve=>server.close(resolve));}
  }finally{
    for(const[name,value]of saved){if(value)require.cache[name]=value;else delete require.cache[name];}
    if(previous===undefined)delete process.env.CASHFLOW_JWT_SECRET;else process.env.CASHFLOW_JWT_SECRET=previous;
    if(previousTimeout===undefined)delete process.env.KEA_AUTH_DB_TIMEOUT_MS;else process.env.KEA_AUTH_DB_TIMEOUT_MS=previousTimeout;
  }
}
module.exports={run};
