'use strict';
// A minimal Fastify app that validates its environment before it opens a port.
const Fastify = require('fastify');
const { EnvSaafError, validateEnv } = require('env-saaf');

let config;
try {
  config = validateEnv({
    PORT:      { type: 'port', default: 3000 },
    HOST:      { type: 'ipv4', default: '127.0.0.1' },
    APP_DEBUG: { type: 'boolean', default: false },
    LOG_LEVEL: { type: 'string', choices: ['debug', 'info', 'warn', 'error'], default: 'info' },
  });
} catch (error) {
  if (!(error instanceof EnvSaafError)) throw error;
  console.error('Invalid configuration. Set PORT to an integer from 0 to 65535, APP_DEBUG to true or false, '
    + 'and LOG_LEVEL to debug, info, warn or error.');
  process.exit(1);
}

const app = Fastify({ logger: { level: config.LOG_LEVEL } });
app.get('/health', async () => ({ ok: true, debug: config.APP_DEBUG }));

app.listen({ port: config.PORT, host: config.HOST }).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
