'use strict';
const { check, section } = require('./harness');
const { ownership, userCacheKeys, invalidateUserCache } = require('../services/userCacheOwnership');
const fs = require('fs');
const vm = require('vm');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');

async function run() {
  section('Exact user cache ownership and strict cache DELETE sessions');
  const own = ['context:user:1:account:21','userdata:1','balances:21:1',
    'transactions:1:21:2026-01','accounts:selected:1','lastupdated:1',
    'summarization:session:1:account:21:hash','autocat:u1:a21:mshop100:p21'];
  const foreign = ['userdata:21','userdata:100','balances:1:21',
    'context:user:21:account:1','transactions:100:1:1',
    'summarization:session:21:account:1:1','autocat:u21:a1:m1:p1',
    'session:1','session:21','session:100','kea:dialogue:21','dialogue:1','summary:1',
    'summarization:tool:selectedaccount:21:1','unregistered:1'];
  let store = new Map([...own,...foreign].map(k=>[k,'fixture']));
  let mode = ''; let deletes = 0;
  const redis = {
    // Deliberately return unrelated keys and duplicates, irrespective of MATCH.
    scan: async () => { if(mode==='scan') throw Error('PRIVATE'); return ['0',[...store.keys(),...own]]; },
    unlink: async (...keys) => { if(mode==='unlink') throw Error('PRIVATE'); if(mode==='unsupported') throw Error("ERR unknown command 'UNLINK'"); deletes++; let n=0; for(const key of keys) n+=store.delete(key)?1:0; return n; },
    del: async (...keys) => { deletes++; let n=0; for(const key of keys) n+=store.delete(key)?1:0; return n; },
    ttl: async key=>{ check('stats TTL reads own keys only',ownership(1).owns(key)); return 60; },
    get: async key=>{ check('stats values read own keys only',ownership(1).owns(key)); return store.get(key); },
  };
  check('enumeration filters and deduplicates', (await userCacheKeys(redis,1)).length===own.length);
  check('all declared cache families match',own.every(k=>ownership(1).owns(k)));
  check('foreign and conversation namespaces rejected',foreign.every(k=>!ownership(1).owns(k)));
  for(const value of ['*','1:*',0,-1,{},NaN]) { let rejected=false;try{ownership(value);}catch(_){rejected=true;}check('invalid owner rejected '+String(value),rejected); }
  const module = { exports:{} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../services/contextCache.service'),'utf8'), {
    module, exports:module.exports, Buffer, console,
    require:name=> name==='./redisService'?redis:name==='./userCacheOwnership'?require('../services/userCacheOwnership'):name==='../tools/functionMap'?{functionMap:{}}:require(name),
  });
  const context = module.exports;
  const stats=await context.getCacheStats(1);
  check('actual stats reports own keys only',stats.totalKeys===own.length && stats.keys.every(x=>own.includes(x.key)));
  check('actual invalidation counts distinct removed keys',await context.invalidateUserCache(1)===own.length);
  check('foreign and all histories retained',foreign.every(k=>store.has(k)));
  for(const failure of ['scan','unlink']) {
    mode=failure;store=new Map([...own,...foreign].map(k=>[k,'fixture']));deletes=0;
    let failed=false;try{await context.invalidateUserCache(1);}catch(e){failed=e.message==='Cache invalidation unavailable';}
    check(failure+' fails rather than reporting success',failed && deletes===0 && foreign.every(k=>store.has(k)));
  }
  mode='scan';let failed=false;try{await context.getCacheStats(1);}catch(e){failed=e.message==='Cache statistics unavailable';}
  check('stats scan failure propagates sanitized error',failed);
  mode='unsupported';check('old Redis UNLINK fallback preserves ownership',await invalidateUserCache(redis,1)===own.length && foreign.every(k=>store.has(k)));

  // Exercise the real router and authentication middleware. Handlers count entry
  // so every rejected session proves no cache operation can run.
  const saved=new Map(); const originalSecret=process.env.CASHFLOW_JWT_SECRET;
  const originalTimeout=process.env.KEA_AUTH_DB_TIMEOUT_MS;
  let dbMode='active', calls=0;
  function replace(file,exports){const name=require.resolve(file);saved.set(name,require.cache[name]);require.cache[name]={id:name,filename:name,loaded:true,exports};}
  const route=require.resolve('../routes/cacheRoutes');saved.set(route,require.cache[route]);
  let server;
  try {
    process.env.CASHFLOW_JWT_SECRET='cache-fixture-secret'; process.env.KEA_AUTH_DB_TIMEOUT_MS='1000';
    replace('../services/db',{query:async(_sql,args)=>{if(dbMode==='error')throw Error('PRIVATE');if(dbMode==='timeout')return new Promise(()=>{});return dbMode==='revoked'?[]:[{id:args[0]}];}});
    const handler=(_req,res)=>{calls++;res.json({success:true});};
    replace('../controllers/cacheController',Object.fromEntries(['invalidateUserCache','invalidateAccountCache','flushSummarizationCache','flushAutoCategorizeCache','flushLLMCache','warmUpCache','getCacheStats','getCacheHealth'].map(k=>[k,handler])));
    delete require.cache[route]; const app=express();app.use(express.json());app.use(require(route));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const request=(path,token)=>new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path,method:'DELETE',headers:token?{Authorization:'Bearer '+token}:{}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.end();});
    const sign=extra=>jwt.sign({id:1,jti:'cache-session',...extra},process.env.CASHFLOW_JWT_SECRET,{expiresIn:'5m'});
    for(const path of ['/user/1','/user/1/account/21']) {
      for(const [name,token,status,db] of [['missing',null,401,'active'],['no JTI',sign({jti:undefined}),401,'active'],['revoked',sign({}),401,'revoked'],['store failure',sign({}),503,'error'],['store timeout',sign({}),503,'timeout']]) {
        dbMode=db;calls=0;const actual=await request(path,token);
        check(path+' '+name+' denied before cache',actual===status && calls===0);
      }
      dbMode='active';calls=0;check(path+' active session reaches handler',await request(path,sign({}))===200 && calls===1);
    }
  } finally {
    if(server)await new Promise(resolve=>server.close(resolve));
    for(const [key,value]of saved)if(value)require.cache[key]=value;else delete require.cache[key];
    if(originalSecret===undefined)delete process.env.CASHFLOW_JWT_SECRET;else process.env.CASHFLOW_JWT_SECRET=originalSecret;
    if(originalTimeout===undefined)delete process.env.KEA_AUTH_DB_TIMEOUT_MS;else process.env.KEA_AUTH_DB_TIMEOUT_MS=originalTimeout;
  }
}
module.exports={run};
