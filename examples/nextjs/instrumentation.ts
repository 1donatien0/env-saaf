// Runs once when the Node.js server boots, before requests are handled.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./lib/env');
  }
}
