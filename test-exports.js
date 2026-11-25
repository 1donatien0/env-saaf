'use strict';
// Issue #357: package.json exports the public entry only, so deep imports of
// internal files stop working. Self-reference (`require('env-saaf')` from the
// package itself) goes through the same exports map a consumer uses.
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const EXPECTED = [
  'EnvSaafError', 'diffEnv', 'generateExample', 'loadEnv', 'loadEnvAsync', 'maskSecrets',
  'maskValue', 'parseEnvFile', 'scanCode', 'scanDir', 'toJsonSchema', 'validateEnv',
  'validateSchema',
];

function run(args, extraEnv) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...extraEnv },
  });
  assert.ifError(result.error);
  return result;
}

function must(result, what) {
  assert.strictEqual(result.status, 0, `${what}\n${result.stdout || ''}${result.stderr || ''}`);
  return result;
}

// CommonJS self-reference: every export, sorted.
const cjs = must(run([process.execPath, '-e', `
  const mod = require('env-saaf');
  const keys = Object.keys(mod).sort();
  const expected = ${JSON.stringify(EXPECTED)};
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    console.error('exports differ:', keys);
    process.exit(1);
  }
  console.log('cjs ok');
`]), 'the CommonJS entry');

// ESM named imports must resolve from the CommonJS file.
const esm = must(run([process.execPath, '--input-type=module', '-e', `
  import { validateEnv, EnvSaafError } from 'env-saaf';
  if (typeof validateEnv !== 'function' || typeof EnvSaafError !== 'function') process.exit(1);
  console.log('esm ok');
`]), 'the ESM entry');

// Internal files are no longer public API.
const deep = run([process.execPath, '-e', "require('env-saaf/cli.js')"]);
assert.notStrictEqual(deep.status, 0, 'env-saaf/cli.js is still deep-importable');
assert.match(deep.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED|Package subpath/);

// Types resolve through the exports map under node16 and bundler resolution.
const consumer = path.join(ROOT, '.test-exports-consumer.ts');
fs.writeFileSync(consumer, [
  "import { validateEnv, type EnvSaafError } from 'env-saaf';",
  "const env = validateEnv({ PORT: { type: 'port', required: true } });",
  'const port: number = env.PORT;',
  'const failure: EnvSaafError | null = null;',
  'void port; void failure;',
  '',
].join('\n'));
try {
  for (const resolution of ['node16', 'bundler']) {
    must(run([process.execPath, TSC, '--noEmit', '--strict', '--target', 'es2022',
      '--module', resolution === 'bundler' ? 'esnext' : 'node16',
      '--moduleResolution', resolution, consumer]), `type-checking with ${resolution} resolution`);
  }
} finally {
  fs.rmSync(consumer, { force: true });
}

assert.match(cjs.stdout, /cjs ok/);
assert.match(esm.stdout, /esm ok/);
console.log('test-exports.js: exports map, both module systems and both type resolutions passed');
