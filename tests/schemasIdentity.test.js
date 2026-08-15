'use strict';

const fs = require('fs');
const path = require('path');
const { check, section } = require('./harness');

async function run() {
  section('chat tool schemas have no model-controlled identity');

  const schemas = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'tools', 'keacast_functions_schemas.json'), 'utf8')
  );
  check('schemas file is an array', Array.isArray(schemas));

  const identityHits = [];
  for (const item of schemas) {
    const name = item?.function?.name;
    const props = item?.function?.parameters?.properties || {};
    const required = item?.function?.parameters?.required || [];
    for (const key of ['token', 'userId']) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        identityHits.push(`${name}.properties.${key}`);
      }
      if (required.includes(key)) {
        identityHits.push(`${name}.required.${key}`);
      }
    }
  }
  check('no token/userId properties or required fields', identityHits.length === 0, identityHits.join(', '));
}

module.exports = { run };
