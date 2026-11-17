'use strict';
const { check, section } = require('./harness');
const { id, readCapabilities, authorizeAccount, sanitizeAccounts } = require('../services/legacyReadAuthorization');

async function run() {
  section('SEC-01 legacy read authorization');
  // Valid product-grant matrix pinned to backend accountTransactionAuth at
  // cd988ab8d157a053ed1c77e9fad4225a37f34dd0 (expandPermissionLabels/read caps).
  for (const [grant, forecast] of [
    ['View', false], ['Administrator', false], ['Notifications', false], ['Balances', false],
    ['Forecast', true], ['Reconcile', true], ['All', true], ['Owner', true], ['Full Access', true],
    ['View + Balances', false], ['View Balances', false], ['Reconciliation', true], ['Forecasting', true],
    ['All + Notifications + Administrator', true], ['["View","Forecast"]', true],
    [{read:'Forecast'}, true], [['View','Balances'], false],
  ]) {
    const caps = readCapabilities(grant);
    check(`recognized ${JSON.stringify(grant)} transaction capability`, caps.has('TRANSACTION_READ'));
    check(`recognized ${JSON.stringify(grant)} forecast capability`, caps.has('FORECAST_READ') === forecast);
  }
  for (const grant of [null, '', [], {}, 'Unknown', 'NotView', 'Forecast + invalid', '["View"', 1, ['View', null], 'View +']) {
    check(`malformed ${JSON.stringify(grant)} denies`, readCapabilities(grant).size === 0);
  }
  for (const value of [null, [], {}, '1 OR 1=1', '1.2', -1, '1e2', Number.MAX_SAFE_INTEGER+1]) {
    check('invalid identity rejected '+JSON.stringify(value), id(value) === null);
  }
  const account = { accountid: 10, userid: 1, satelite_id: 8 };
  const relation = { satelite_id:8, owner_id:1, satelite_user_id:2, permission_level:'View' };
  async function attempt(actor, operation, relationships, row = account) {
    const calls = [];
    try {
      const result = await authorizeAccount(actor,10,operation,{queryFn:async(sql,args)=>{
        calls.push({sql,args}); return sql.includes('FROM accounts') ? (row?[row]:[]) : relationships;
      }});
      return { result, calls };
    } catch(error) { return { error, calls }; }
  }
  let r = await attempt(1,'FORECAST_READ',[]);
  check('owner authorized without satellite query',r.result?.role==='OWNER' && r.calls.length===1);
  r = await attempt(2,'TRANSACTION_READ',[relation]);
  check('recognized satellite transaction read',r.result?.role==='SATELLITE');
  check('bound relationship query',r.calls[1].args[0]===8 && r.calls[1].args[1]==='2');
  for (const [name, actor, op, rows, row] of [
    ['View cannot read forecasts',2,'FORECAST_READ',[relation]],
    ['missing membership',2,'TRANSACTION_READ',[]],
    ['unrelated actor',3,'TRANSACTION_READ',[relation]],
    ['wrong owner binding',2,'TRANSACTION_READ',[{...relation,owner_id:99}]],
    ['conflicting grants',2,'TRANSACTION_READ',[relation,{...relation,permission_level:'Forecast'}]],
    ['unknown grant',2,'TRANSACTION_READ',[{...relation,permission_level:'bogus'}]],
    ['missing account',2,'TRANSACTION_READ',[],null],
    ['unsupported operation',1,'BALANCE_READ',[]],
  ]) {
    r=await attempt(actor,op,rows,row);
    check(name,r.error?.code==='LEGACY_ACCESS_DENIED');
  }
  r=await attempt(2,'FORECAST_READ',[{...relation,permission_level:'Forecast'}]);
  check('Forecast satellite authorized',r.result?.role==='SATELLITE');
  const original={accounts:[{accountid:10,access_token:'synthetic-secret',processor_token:'synthetic-processor',disabled_access_token:'synthetic-disabled',balance:100}],pagination:{page:2,total:4}};
  const safe=sanitizeAccounts(original);
  check('all known account credentials stripped without changing owner balance',['access_token','processor_token','disabled_access_token'].every(k=>!Object.prototype.hasOwnProperty.call(safe.accounts[0],k)) && safe.accounts[0].balance===100);
  check('pagination retained and source not mutated',safe.pagination===original.pagination && original.accounts[0].access_token==='synthetic-secret');
}
module.exports={run};
