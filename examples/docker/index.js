'use strict';

const { EnvSaafError, validateEnv } = require('env-saaf');

function main() {
  let config;
  try {
    config = validateEnv({
      APP_NAME: { type: 'string', default: 'env-saaf-docker' },
      PORT: { type: 'port', required: true },
      APP_DEBUG: { type: 'boolean', default: false },
      API_URL: { type: 'url', required: true },
      LOG_LEVEL: {
        type: 'string',
        choices: ['debug', 'info', 'warn', 'error'],
        required: true,
      },
    });
  } catch (error) {
    if (!(error instanceof EnvSaafError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Started ${config.APP_NAME}: port=${config.PORT} (${typeof config.PORT}), ` +
    `debug=${config.APP_DEBUG} (${typeof config.APP_DEBUG}), ` +
    `logLevel=${config.LOG_LEVEL}, apiUrl=${config.API_URL}`
  );
}

main();
