'use strict';
const http = require('http');
const express = require('express');
const { Writable } = require('stream');
const { check, section } = require('./harness');
const { safeLogPath } = require('../middleware/logSafeUrl');
const { createAccessLogger } = require('../middleware/accessLogging');

function capture() {
  const lines=[];
  const stream=new Writable({write(chunk,encoding,next){lines.push(chunk.toString());next();}});
  return {stream,lines};
}

function loadPinoMiddleware(file, stream) {
  const pinoFile=require.resolve('pino-http');
  const middlewareFile=require.resolve(file);
  const originalPino=require('pino-http');
  const savedPino=require.cache[pinoFile];
  const savedMiddleware=require.cache[middlewareFile];
  require.cache[pinoFile]={id:pinoFile,filename:pinoFile,loaded:true,exports:opts=>originalPino(opts,stream)};
  delete require.cache[middlewareFile];
  try { return require(file); }
  finally {
    require.cache[pinoFile]=savedPino;
    if(savedMiddleware)require.cache[middlewareFile]=savedMiddleware;else delete require.cache[middlewareFile];
  }
}

async function run() {
  section('SEC-01 emitted request/referrer URL logs');
  for(const [input,expected] of [
    ['/api/agent/clear-history?token=secret&token=again#private','/api/agent/clear-history'],
    ['https://user:secret@example.invalid/a?access_token=secret','/a'],
    ['//user:secret@example.invalid/b?%74oken=secret','/b'],
    ['/c?Authorization=secret&signed=secret','/c'],
    ['http://[malformed?token=secret','[invalid-url]'],
    ['data:secret','[invalid-url]'],[null,'-'],
  ]) check('safe serialization '+String(input),safeLogPath(input)===expected);

  for(const env of ['production','development']) {
    const primary=capture(),secondary=capture(),access=capture();
    const app=express();
    app.use(loadPinoMiddleware('../middleware/logging',primary.stream));
    app.use(loadPinoMiddleware('../middleware/securityHeaders',secondary.stream));
    app.use(createAccessLogger({nodeEnv:env,stream:access.stream}));
    let observed;
    app.use((req,res)=>{
      observed={url:req.url,originalUrl:req.originalUrl,query:req.query,referrer:req.headers.referer};
      res.status(req.path==='/error'?500:200).json({success:true});
    });
    const server=http.createServer(app);
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      for(const path of ['/api/agent/clear-history?sessionId=1&token=SYNTHETIC_JWT&%74oken=SECOND_SECRET#PRIVATE_FRAGMENT','/error?access_token=ERROR_SECRET']) {
        const referrer='https://user:REFERRER_PASSWORD@example.invalid/from?token=REFERRER_JWT#PRIVATE_REF';
        await new Promise((resolve,reject)=>{
          const req=http.request({host:'127.0.0.1',port:server.address().port,path,headers:{Referer:referrer,Authorization:'Bearer HEADER_SECRET','x-auth-token':'SECOND_HEADER_SECRET'}},res=>{res.resume();res.on('end',resolve);});
          req.on('error',reject);req.end();
        });
        check(env+' raw request URL remains available to auth/router',observed.url===path && observed.originalUrl===path && observed.referrer===referrer);
      }
      await new Promise(resolve=>setImmediate(resolve));
      for(const [label,output] of [['primary',primary.lines.join('')],['secondary',secondary.lines.join('')],['access',access.lines.join('')]]) {
        check(env+' '+label+' emits actual logs',output.length>0);
        check(env+' '+label+' request/referrer credentials absent',!['SYNTHETIC_JWT','SECOND_SECRET','PRIVATE_FRAGMENT','ERROR_SECRET','REFERRER_JWT','REFERRER_PASSWORD','PRIVATE_REF','HEADER_SECRET'].some(secret=>output.includes(secret)));
        check(env+' '+label+' method/path/status retained',output.includes('/api/agent/clear-history') && output.includes('GET') && output.includes('500'));
      }
      for(const lines of [primary.lines,secondary.lines]) {
        const records=lines.join('').trim().split('\n').map(line=>JSON.parse(line));
        check(env+' JSON serializers emit paths only',records.every(record=>!record.req || !record.req.url.includes('?')));
      }
      if(env==='production')check('combined referrer retains only safe path',access.lines.join('').includes('"/from"'));
    } finally {await new Promise(resolve=>server.close(resolve));}
  }
}
module.exports={run};
