// Server-only configuration. Never import this from a Client Component.
import { EnvSaafError, validateEnv } from 'env-saaf';

function load() {
  try {
    return validateEnv({
      DATABASE_URL: { type: 'url', required: true },
      AUTH_SECRET:  { type: 'string', minLength: 32, required: true, sensitive: true },
      LOG_LEVEL:    { type: 'string', choices: ['debug', 'info', 'warn', 'error'], default: 'info' },
    });
  } catch (error) {
    if (!(error instanceof EnvSaafError)) throw error;
    // The instrumentation hook is loaded before the server is ready; leaving
    // the process up after this error would serve with no validated config.
    console.error(error.message);
    process.exit(1);
  }
}

export const serverEnv = load();
