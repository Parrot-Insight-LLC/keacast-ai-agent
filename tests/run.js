'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { totals } = require('./harness');

const suites = [
  './cashflowAuth.test.js',
  './keaAccountAccess.test.js',
  './keaIdentity.test.js',
  './schemasIdentity.test.js',
  './keaTelemetry.test.js',
  './keaAccountSnapshot.test.js',
  './keaContextResolve.test.js',
  './selectedAccountObservability.test.js',
  './corsPreflight.test.js',
  './writeGate.test.js',
  './rollingSummary.test.js',
  './keaCapabilityRouter.test.js',
  './keaGroundingPolicy.test.js',
  './keaToolBundles.test.js',
  './keaGroundingPrefetch.test.js',
  './keaFinancialMacros.test.js',
  './keaPeriodComparison.test.js',
  './keaTrendAnalysis.test.js',
  './keaInvitationContinuation.test.js',
  './keaWriteCommitAck.test.js',
  './keaWriteIdentity.test.js',
  './keaPhase12.test.js',
];

async function main() {
  console.log('\nKea Phase 0+1 tests\n===================');
  for (const file of suites) {
    const mod = require(file);
    await mod.run();
  }

  console.log('\nlegacy test-kea-memory.js');
  const mem = spawnSync(process.execPath, [path.join(__dirname, '..', 'test-kea-memory.js')], {
    encoding: 'utf8',
    env: process.env,
  });
  if (mem.stdout) process.stdout.write(mem.stdout);
  if (mem.stderr) process.stderr.write(mem.stderr);
  const memoryFailed = mem.status !== 0;

  const { passed, failed } = totals();
  console.log(`\n=================\nPhase 0+1 suite: Passed: ${passed}  Failed: ${failed}`);
  console.log(`test-kea-memory.js: ${memoryFailed ? 'FAILED' : 'PASSED'}`);
  process.exit(failed === 0 && !memoryFailed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
