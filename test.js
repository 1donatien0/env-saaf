'use strict';
const assert = require('node:assert');
const { validateEnv, EnvSaafError, parseEnvFile, scanCode, diffEnv, maskSecrets, maskValue, generateExample } = require('./index');

// v0.1.0 core
const env = validateEnv({
  PORT: { type: 'port', required: true },
  DEBUG: { type: 'boolean', default: false },
  API_URL: { type: 'url', required: true },
}, { PORT: '3000', DEBUG: 'false', API_URL: 'https://example.com' });
assert.strictEqual(env.PORT + 1, 3001);
assert.strictEqual(env.DEBUG, false);
assert.throws(() => validateEnv({ A: { required: true } }, {}), EnvSaafError);

// v0.2.0
assert.deepStrictEqual(parseEnvFile('PORT=3000\nNAME="my app"\n'), { PORT: '3000', NAME: 'my app' });
assert.deepStrictEqual(scanCode('process.env.API_URL; const { PORT } = process.env;'), ['API_URL', 'PORT']);
assert.deepStrictEqual(diffEnv(['A', 'B'], ['A', 'C']), { usedNotDocumented: ['B'], documentedNotUsed: ['C'] });

// v1.0.0: masking — a real secret is never printed in full
assert.strictEqual(maskValue('sk_live_123456'), 'sk***56');
assert.strictEqual(maskValue('abc'), '****');
assert.deepStrictEqual(maskSecrets({ KEY: 'sk_live_123456' }), { KEY: 'sk***56' });
// v1.0.0: generateExample — placeholders/defaults only, never a real secret
const ex = generateExample({ PORT: { type: 'port', required: true }, API_KEY: { type: 'string', required: true } });
assert.ok(ex.includes('PORT=3000'));
assert.ok(ex.includes('API_KEY=your_value_here'));
assert.ok(!ex.includes('sk_live'));

// scanDir also scans .mts/.cts files
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanDir } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-'));
  fs.writeFileSync(path.join(dir, 'a.mts'), 'export const x = process.env.FROM_MTS;');
  fs.writeFileSync(path.join(dir, 'b.cts'), 'export const y = process.env.FROM_CTS;');
  fs.writeFileSync(path.join(dir, 'c.ts'), 'export const z = process.env.FROM_TS;');
  assert.deepStrictEqual(scanDir(dir), ['FROM_CTS', 'FROM_MTS', 'FROM_TS']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #14: parseEnvFile — strip inline comments after unquoted values;
// '#' inside quotes is safe; a comment after a quoted value is stripped too
{
  const { parseEnvFile, loadEnv } = require('./index');
  assert.deepStrictEqual(
    parseEnvFile('PORT=3000 # my port\nDEBUG=true # enable logs\nNAME="x # y"\nNOTE=\'a # b\' # trailing\nEMPTY= # nothing\nURL=https://example.com/#frag\n'),
    { PORT: '3000', DEBUG: 'true', NAME: 'x # y', NOTE: 'a # b', EMPTY: '', URL: 'https://example.com/#frag' }
  );
  // end-to-end: a .env file with inline comments validates via loadEnv
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-inline-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'PORT=4000 # app port\nDEBUG=true # verbose\n');
  const envInline = loadEnv(
    { PORT: { type: 'port', required: true }, DEBUG: { type: 'boolean', default: false } },
    { path: file, env: {} }
  );
  assert.strictEqual(envInline.PORT, 4000);
  assert.strictEqual(envInline.DEBUG, true);
  fs.rmSync(dir, { recursive: true, force: true });
}

// feat: loadEnv — read a .env file and validate it in one call (fixes #2)
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-loadenv-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'PORT=4000\nDEBUG=true\nAPI_URL=https://api.example.com/v1\n');
  const schema = {
    PORT: { type: 'port', required: true },
    DEBUG: { type: 'boolean', default: false },
    API_URL: { type: 'url', required: true },
  };
  // basic: file se typed values
  const env1 = loadEnv(schema, { path: file, env: {} });
  assert.strictEqual(env1.PORT, 4000);
  assert.strictEqual(env1.DEBUG, true);
  assert.strictEqual(env1.API_URL, 'https://api.example.com/v1');
  assert.ok(Object.isFrozen(env1));
  // override: false (default) — the base env wins; true — the file wins
  assert.strictEqual(loadEnv(schema, { path: file, env: { PORT: '5000' } }).PORT, 5000);
  assert.strictEqual(loadEnv(schema, { path: file, env: { PORT: '5000' }, override: true }).PORT, 4000);
  // assign: validated values are written back into the base env as strings
  const target = {};
  loadEnv(schema, { path: file, env: target, assign: true });
  assert.strictEqual(target.PORT, '4000');
  assert.strictEqual(target.DEBUG, 'true');
  // without assign, a process.env-like base env stays untouched
  const untouched = { PORT: '5000' };
  loadEnv(schema, { path: file, env: untouched });
  assert.strictEqual(untouched.PORT, '5000');
  assert.strictEqual(untouched.DEBUG, undefined);
  // missing file + required schema -> saaf error
  assert.throws(() => loadEnv(schema, { path: path.join(dir, 'nope.env'), env: {} }), /file not found/);
  // missing file + sab optional -> defaults, no throw
  const env4 = loadEnv({ PORT: { type: 'port', default: 3000 } }, { path: path.join(dir, 'nope.env'), env: {} });
  assert.strictEqual(env4.PORT, 3000);
  fs.rmSync(dir, { recursive: true, force: true });
}

// feat: strict mode — flag variables that are set but not in the schema (fixes #4)
{
  const schema = { PORT: { type: 'port', required: true } };
  // non-strict (default): extra keys are ignored
  assert.strictEqual(validateEnv(schema, { PORT: '3000', DATABSE_URL: 'x' }).PORT, 3000);
  // strict: an unknown key becomes an error
  assert.throws(
    () => validateEnv(schema, { PORT: '3000', DATABSE_URL: 'x' }, { strict: true }),
    /DATABSE_URL: set but not in schema/
  );
  // an empty value is ignored in strict mode too (treated as missing)
  assert.strictEqual(validateEnv(schema, { PORT: '3000', EMPTY_VAR: '' }, { strict: true }).PORT, 3000);
  // ek hi pass me saari problems: unknown + missing
  assert.throws(
    () => validateEnv(schema, { DATABSE_URL: 'x' }, { strict: true }),
    (e) => e instanceof EnvSaafError
      && e.errors.length === 2
      && e.errors.some(m => m.includes('DATABSE_URL'))
      && e.errors.some(m => m.includes('PORT: missing'))
  );
}

// Issue #3: a 'url' value must come back exactly as given —
// no normalization (no added trailing slash), but an invalid URL must error
{
  const out = validateEnv({ API_URL: { type: 'url', required: true } }, { API_URL: 'https://api.example.com' });
  assert.strictEqual(out.API_URL, 'https://api.example.com');
  const out2 = validateEnv({ API_URL: { type: 'url', required: true } }, { API_URL: 'https://api.example.com/v1?x=1' });
  assert.strictEqual(out2.API_URL, 'https://api.example.com/v1?x=1');
  assert.throws(() => validateEnv({ U: { type: 'url' } }, { U: 'not a url' }), /valid URL/);
}

// Issue #5: CLI 'check --file <name>' — compare against the given file instead of .env.example
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MY_FLAG;');
  fs.writeFileSync(path.join(dir, '.env.sample'), 'MY_FLAG=1\n');
  const cli = path.join(__dirname, 'cli.js');
  // --file .env.sample: everything is documented, exit 0 (must not throw)
  execFileSync('node', [cli, 'check', dir, '--file', '.env.sample'], { stdio: 'pipe' });
  // without --file: no .env.example present, exit 2
  let code = 0;
  try { execFileSync('node', [cli, 'check', dir], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #15: scanCode — let aur var destructuring of process.env (previously only const)
{
  assert.deepStrictEqual(
    scanCode('let { A } = process.env; var { B } = process.env; const { C } = process.env;'),
    ['A', 'B', 'C']
  );
  assert.deepStrictEqual(
    scanCode('let { API_URL: api = "http://localhost" } = process.env; var { PORT = 3000 } = process.env;'),
    ['API_URL', 'PORT']
  );
}

// Issue #18: boolean type — also accept 'on'/'off' (and 'y'/'n')
{
  const b = (v) => validateEnv({ F: { type: 'boolean' } }, { F: v }).F;
  assert.strictEqual(b('on'), true);
  assert.strictEqual(b('ON'), true);
  assert.strictEqual(b('On'), true);
  assert.strictEqual(b('off'), false);
  assert.strictEqual(b('OFF'), false);
  assert.strictEqual(b('Off'), false);
  assert.strictEqual(b('y'), true);
  assert.strictEqual(b('n'), false);
  assert.strictEqual(b('yes'), true);
  assert.strictEqual(b('no'), false);
  assert.strictEqual(b('1'), true);
  assert.strictEqual(b('0'), false);
  assert.throws(() => validateEnv({ F: { type: 'boolean' } }, { F: 'enabled' }), /expected a boolean/);
  // end-to-end: a .env file with FEATURE_X=on / DEBUG=off
  const { parseEnvFile } = require('./index');
  const parsed = validateEnv(
    { FEATURE_X: { type: 'boolean' }, DEBUG: { type: 'boolean' } },
    parseEnvFile('FEATURE_X=on\nDEBUG=off\n')
  );
  assert.strictEqual(parsed.FEATURE_X, true);
  assert.strictEqual(parsed.DEBUG, false);
}

// Issue #19: CLI '--help' / '-h' — print usage, exit 0 (asking for help is not an error)
{
  const { execFileSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  // --help aur -h: exit 0, usage text stdout par
  const outHelp = execFileSync('node', [cli, '--help'], { encoding: 'utf8' });
  assert.ok(outHelp.includes('Usage: env-saaf'));
  const outH = execFileSync('node', [cli, '-h'], { encoding: 'utf8' });
  assert.ok(outH.includes('Usage: env-saaf'));
  // an unknown command still exits 2
  let code = 0;
  try { execFileSync('node', [cli, 'frobnicate'], { stdio: 'pipe' }); } catch (e) { code = e.status; }
  assert.strictEqual(code, 2);
  // no-args ab bhi usage + exit 0
  const outNone = execFileSync('node', [cli], { encoding: 'utf8' });
  assert.ok(outNone.includes('Usage: env-saaf'));
}

// Issue #24: CLI --json output for check and scan
{
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-json-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MISSING_KEY;\nconst y = process.env.OK_KEY;');
  fs.writeFileSync(path.join(dir, '.env.example'), 'OK_KEY=1\nEXTRA_KEY=2\n');

  // check --json: missing used-not-documented, extra documented-not-used, ok false, exit 1
  let code = 0;
  let out = '';
  try {
    out = execFileSync('node', [cli, 'check', dir, '--json'], { encoding: 'utf8' });
  } catch (e) {
    code = e.status;
    out = e.stdout;
  }
  assert.strictEqual(code, 1);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.ok, false);
  assert.deepStrictEqual(parsed.missing, ['MISSING_KEY']);
  assert.deepStrictEqual(parsed.extra, ['EXTRA_KEY']);
  assert.deepStrictEqual(parsed.invalid, []);

  // scan --json: lists vars, ok true, exit 0
  const scanOut = execFileSync('node', [cli, 'scan', dir, '--json'], { encoding: 'utf8' });
  const scanParsed = JSON.parse(scanOut);
  assert.strictEqual(scanParsed.ok, true);
  assert.deepStrictEqual(scanParsed.vars.sort(), ['MISSING_KEY', 'OK_KEY']);

  // human output still default (no --json)
  const humanOut = execFileSync('node', [cli, 'scan', dir], { encoding: 'utf8' });
  assert.ok(humanOut.includes('MISSING_KEY'));
  assert.ok(!humanOut.includes('{'));

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('env-saaf v1.1.0: all tests passed');
