'use strict';

const express = require('express');
const { EnvSaafError, validateEnv } = require('env-saaf');

function main() {
  let config;
  try {
    config = validateEnv({
      PORT: { type: 'port', default: 3000 },
      APP_DEBUG: { type: 'boolean', default: false },
    });
  } catch (error) {
    if (!(error instanceof EnvSaafError)) throw error;
    console.error('Invalid configuration. Set PORT to an integer from 0 to 65535 and APP_DEBUG to true or false.');
    process.exitCode = 1;
    return;
  }

  const app = express();
  app.get('/health', (_request, response) => {
    response.json({ ok: true, debug: config.APP_DEBUG });
  });

  const server = app.listen(config.PORT, '127.0.0.1', error => {
    if (error) {
      console.error(`Could not start the server (${error.code}).`);
      process.exitCode = 1;
      return;
    }
    console.log(`Listening on http://127.0.0.1:${server.address().port}`);
  });
}

main();
