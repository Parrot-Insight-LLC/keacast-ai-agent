'use strict';

const { check, section } = require('./harness');
const {
  LOCAL_ANGULAR_ORIGIN,
  CAPACITOR_WEBVIEW_ORIGINS,
  resolveCorsOrigins,
} = require('../middleware/corsConfig');

async function run() {
  section('corsConfig Capacitor origins');

  check('non-production allows all origins', resolveCorsOrigins({ nodeEnv: 'development' }) === true);

  const prod = resolveCorsOrigins({
    nodeEnv: 'production',
    allowedOriginsEnv: 'https://keacast.app',
  });
  check('production includes keacast.app from env', prod.includes('https://keacast.app'));
  check('production includes local Angular', prod.includes(LOCAL_ANGULAR_ORIGIN));
  check(
    'production includes Capacitor Android https://localhost',
    prod.includes('https://localhost')
  );
  check(
    'production includes Capacitor iOS capacitor://localhost',
    prod.includes('capacitor://localhost')
  );
  check(
    'production includes legacy ionic://localhost',
    prod.includes('ionic://localhost')
  );
  check(
    'Capacitor origin list is exactly the three WebView origins',
    CAPACITOR_WEBVIEW_ORIGINS.length === 3
    && CAPACITOR_WEBVIEW_ORIGINS.indexOf('https://evil.example') === -1
  );
  check('production does not allow arbitrary origins', prod.indexOf('https://evil.example') === -1);
}

module.exports = { run };
