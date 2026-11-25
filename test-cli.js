'use strict';
// Issue #237: CLI integration tests. These run `cli.js` as a real subprocess
// (spawnSync) in throwaway projects under the OS temp dir, because the
// behaviours users depend on — exit codes, stdout vs stderr, --json shape,
// "type": "module" handling, missing-directory errors — are process-level
// and cannot be pinned by calling into the internals from test.js.
//
// Conventions match test.js: plain node:assert, no framework. Every project
// is created fresh and removed afterwards, and the child process gets a
// scrubbed environment so the developer's real env vars and cwd cannot leak
// into the results.
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, 'cli.js');

/** A minimal environment for the child: enough for Node to start, nothing else. */
function cleanEnv() {
  const env = { PATH: process.env.PATH || '' };
  if (process.platform === 'win32') {
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
  } else if (process.env.HOME) {
    env.HOME = process.env.HOME;
  }
  return env;
}

/** Run the CLI in `cwd` and return { status, stdout, stderr }. */
function run(args, cwd, input) {
  const opts = {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(),
  };
  if (input !== undefined) opts.input = input;
  const r = spawnSync(process.execPath, [CLI, ...args], opts);
  assert.ifError(r.error);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Create a throwaway project directory; registered for cleanup. */
const tempDirs = [];
function mkProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-test-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
}

function cleanup() {
  for (const d of tempDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

const SRC_WITH_USAGE = 'const port = process.env.PORT;\nconst db = process.env.DATABASE_URL;\nconsole.log(port, db);\n';
const EXAMPLE_BOTH = 'PORT=\nDATABASE_URL=\n';
const SCHEMA = "module.exports = { PORT: { type: 'port', required: true }, DATABASE_URL: { type: 'string', required: true } };\n";
const asyncChecks = [];

try {
  // --- check: clean project exits 0 and says so on stdout -------------------
  {
    const dir = mkProject({ 'src/app.js': SRC_WITH_USAGE, '.env.example': EXAMPLE_BOTH });
    const r = run(['check', dir], dir);
    assert.strictEqual(r.status, 0, `clean check should exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /all clean/);
  }

  // --- check: code reads a key the example does not document -> exit 1, MISSING on stdout
  {
    const dir = mkProject({ 'src/app.js': 'console.log(process.env.SECRET_TOKEN);\n', '.env.example': 'PORT=\n' });
    const r = run(['check', dir], dir);
    assert.strictEqual(r.status, 1, 'missing key must exit 1');
    assert.match(r.stdout, /MISSING in \.env\.example: SECRET_TOKEN/);
  }

  // --- check --json: stdout is one parseable JSON line, findings are fields -
  {
    const dir = mkProject({ 'src/app.js': 'console.log(process.env.SECRET_TOKEN);\n', '.env.example': 'PORT=\n' });
    const r = run(['check', dir, '--json'], dir);
    assert.strictEqual(r.status, 1);
    const parsed = JSON.parse(r.stdout); // must not throw
    assert.strictEqual(parsed.ok, false);
    assert.deepStrictEqual(parsed.missing, ['SECRET_TOKEN']);
    assert.strictEqual(r.stderr, '', 'findings belong on stdout in --json mode');
  }

  // --- --json is a public contract: pin every field and its type (issue #367) --
  {
    const dir = mkProject({ 'src/app.js': 'console.log(process.env.PORT);\n', '.env.example': 'PORT=\n' });
    const parsed = JSON.parse(run(['check', dir, '--json'], dir).stdout);
    assert.deepStrictEqual(parsed, {
      ok: true, missing: [], extra: [], unused: [], invalid: [], secrets: [], envExtra: [], envMissing: [],
    });
    assert.strictEqual(typeof parsed.ok, 'boolean');
    for (const field of ['missing', 'extra', 'unused', 'invalid', 'secrets', 'envExtra', 'envMissing']) {
      assert.ok(Array.isArray(parsed[field]), `${field} must be an array`);
    }
  }

  {
    // One finding of each kind, so no field can be dropped or renamed unnoticed.
    const syntheticExampleSecret = ['sk', 'proj', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4'].join('-');
    const dir = mkProject({
      'src/app.js': 'console.log(process.env.PORT, process.env.DOCUMENTED_USED, process.env.LEAKED_KEY, process.env.UNDOCUMENTED);\n',
      '.env.example': `PORT=\nDOCUMENTED_USED=\nLEAKED_KEY=${syntheticExampleSecret}\nDOCUMENTED_UNUSED=\nMISSING_IN_ENV=\n`,
      '.env': 'DOCUMENTED_USED=1\nLEAKED_KEY=1\nPORT=not-a-port\nEXTRA_IN_ENV=2\n',
      'env.schema.js': "module.exports = { PORT: { type: 'port' } };\n",
    });
    const out = run(['check', dir, '--schema', 'env.schema.js', '--json'], dir).stdout;
    assert.ok(!out.includes(syntheticExampleSecret), 'example secret value must never appear in --json output');
    const parsed = JSON.parse(out);
    assert.deepStrictEqual(Object.keys(parsed).sort(), [
      'documentedNotInSchema', 'envExtra', 'envMissing', 'extra', 'invalid', 'missing', 'ok',
      'schemaNotDocumented', 'secrets', 'unused',
    ]);
    assert.deepStrictEqual(parsed.schemaNotDocumented, []);
    assert.deepStrictEqual(parsed.documentedNotInSchema, ['DOCUMENTED_USED', 'LEAKED_KEY', 'DOCUMENTED_UNUSED', 'MISSING_IN_ENV']);
    assert.strictEqual(parsed.ok, false);
    assert.deepStrictEqual(parsed.missing, ['UNDOCUMENTED']);
    assert.deepStrictEqual(parsed.extra, ['DOCUMENTED_UNUSED', 'MISSING_IN_ENV']);
    assert.deepStrictEqual(parsed.unused, ['DOCUMENTED_UNUSED', 'MISSING_IN_ENV']);
    assert.deepStrictEqual(parsed.secrets, ['LEAKED_KEY']);
    assert.deepStrictEqual(parsed.envExtra, ['EXTRA_IN_ENV']);
    assert.deepStrictEqual(parsed.envMissing, ['DOCUMENTED_UNUSED', 'MISSING_IN_ENV']);
    assert.strictEqual(parsed.invalid.length, 1);
    assert.match(parsed.invalid[0], /PORT/);
    for (const field of ['missing', 'extra', 'unused', 'invalid', 'secrets', 'envExtra', 'envMissing']) {
      for (const item of parsed[field]) assert.strictEqual(typeof item, 'string', `${field} holds strings`);
    }
  }

  {
    const dir = mkProject({
      'src/app.js': 'console.log(process.env.USED_KEY);\n',
      '.env.example': 'USED_KEY=\nOLD_KEY=\n',
    });
    const parsed = JSON.parse(run(['scan', dir, '--json'], dir).stdout);
    assert.deepStrictEqual(parsed, {
      ok: true,
      vars: ['USED_KEY'],
      unused: ['OLD_KEY'],
      locations: { USED_KEY: [{ file: 'src/app.js', line: 1 }] },
    });
  }

  {
    // Without a template there is nothing to compare: no unused field at all.
    const dir = mkProject({ 'src/app.js': 'console.log(process.env.ONLY);\n' });
    assert.deepStrictEqual(JSON.parse(run(['scan', dir, '--json'], dir).stdout), {
      ok: true,
      vars: ['ONLY'],
      locations: { ONLY: [{ file: 'src/app.js', line: 1 }] },
    });
  }

  // --- issue #356: init --from-example infers the unambiguous shapes ---------
  {
    const example = [
      'SESSION_TTL=30m',
      'RELEASE=1.4.2',
      'TRACE_ID=550e8400-e29b-41d4-a716-446655440000',
      'START_DATE=2026-01-31',
      'FEATURE_FLAGS={"beta":true}',
      'BUILD_HASH=deadbeefcafebabe',
      'PLAIN=cafe',
      '',
    ].join('\n');
    const keys = ['SESSION_TTL', 'RELEASE', 'TRACE_ID', 'START_DATE', 'FEATURE_FLAGS', 'BUILD_HASH', 'PLAIN'];
    const dir = mkProject({
      '.env.example': example,
      'src/app.js': 'console.log(' + keys.map(k => `process.env.${k}`).join(', ') + ');\n',
    });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    for (const [key, type] of [
      ['SESSION_TTL', 'duration'], ['RELEASE', 'semver'], ['TRACE_ID', 'uuid'],
      ['START_DATE', 'date'], ['FEATURE_FLAGS', 'json'], ['BUILD_HASH', 'hex'], ['PLAIN', 'string'],
    ]) {
      assert.ok(schemaText.includes(`${key}: { type: '${type}' }`), `${key} should infer as ${type}`);
    }
    // The inferred schema validates the samples it came from.
    const c = run(['check', dir, '--file', '.env.example', '--schema', 'env.schema.js'], dir);
    assert.strictEqual(c.status, 0, c.stdout + c.stderr);
  }

  // --- check --schema: an invalid value in the real .env fails the check ----
  {
    const dir = mkProject({
      'src/app.js': SRC_WITH_USAGE,
      '.env.example': EXAMPLE_BOTH,
      '.env': 'PORT=not-a-port\nDATABASE_URL=x\n',
      'env.schema.js': SCHEMA,
    });
    const r = run(['check', dir, '--schema', 'env.schema.js'], dir);
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /INVALID: PORT/);
    const rj = run(['check', dir, '--schema', 'env.schema.js', '--json'], dir);
    const parsed = JSON.parse(rj.stdout);
    assert.strictEqual(parsed.ok, false);
    assert.ok(Array.isArray(parsed.invalid) && parsed.invalid.length === 1 && /PORT/.test(parsed.invalid[0]));
    assert.ok(!('valuesFile' in parsed), 'without --values the JSON shape is unchanged');
  }

  // --- check --values: validate another environment file (issue #352) -------
  {
    const dir = mkProject({
      'src/app.js': SRC_WITH_USAGE,
      '.env.example': EXAMPLE_BOTH,
      'env.schema.js': SCHEMA,
      '.env.production': 'PORT=8080\nDATABASE_URL=x\n',
      '.env.staging': 'PORT=nope\nDATABASE_URL=x\n',
    });
    const good = run(['check', dir, '--schema', 'env.schema.js', '--values', '.env.production'], dir);
    assert.strictEqual(good.status, 0, good.stdout + good.stderr);
    const bad = run(['check', dir, '--schema', 'env.schema.js', '--values', '.env.staging'], dir);
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stdout, /INVALID in \.env\.staging: PORT/);
    const badJson = JSON.parse(run(['check', dir, '--schema', 'env.schema.js', '--values', '.env.staging', '--json'], dir).stdout);
    assert.strictEqual(badJson.ok, false);
    assert.strictEqual(badJson.valuesFile, '.env.staging');
    assert.strictEqual(badJson.invalid.length, 1);
    assert.match(badJson.invalid[0], /PORT/);
    const missing = run(['check', dir, '--schema', 'env.schema.js', '--values', 'missing.env'], dir);
    assert.strictEqual(missing.status, 2);
    assert.match(missing.stderr, /--values missing\.env not found/);
    const noSchema = run(['check', dir, '--values', '.env.production'], dir);
    assert.strictEqual(noSchema.status, 2);
    assert.match(noSchema.stderr, /--values needs --schema/);
  }

  // --- project config: package.json "env-saaf" key supplies defaults (issue #354)
  {
    const base = {
      'src/app.js': SRC_WITH_USAGE,
      '.env.example': EXAMPLE_BOTH,
      '.env': 'PORT=3000\nDATABASE_URL=postgres://localhost/app\n',
      'env.schema.js': SCHEMA,
    };
    // config schema is used when no --schema flag is given: a bad value fails.
    {
      const dir = mkProject({ ...base, 'package.json': '{"name":"tmp","env-saaf":{"schema":"env.schema.js"}}' });
      const ok = run(['check', dir], dir);
      assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
      const badDir = mkProject({ ...base, '.env': 'PORT=nope\nDATABASE_URL=postgres://localhost/app\n', 'package.json': '{"name":"tmp","env-saaf":{"schema":"env.schema.js"}}' });
      const bad = run(['check', badDir], badDir);
      assert.strictEqual(bad.status, 1);
      assert.match(bad.stdout, /INVALID: PORT/);
    }
    // an explicit flag beats the config: --schema points elsewhere.
    {
      const dir = mkProject({
        ...base,
        '.env': 'PORT=nope\nDATABASE_URL=postgres://localhost/app\n',
        'package.json': '{"name":"tmp","env-saaf":{"schema":"env.schema.js"}}',
        'other.schema.js': "module.exports = { PORT: { type: 'string' }, DATABASE_URL: { type: 'string' } };\n",
      });
      const r = run(['check', dir, '--schema', 'other.schema.js'], dir);
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    }
    // config file: the template name comes from the config when --file is absent.
    {
      const dir = mkProject({
        'src/app.js': SRC_WITH_USAGE,
        '.env.sample': EXAMPLE_BOTH,
        'package.json': '{"name":"tmp","env-saaf":{"file":".env.sample"}}',
      });
      const r = run(['check', dir], dir);
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /code and \.env\.sample match/);
    }
    // config dir: with no directory argument, the configured directory is checked.
    {
      const dir = mkProject({
        'app/src/app.js': SRC_WITH_USAGE,
        'app/.env.example': EXAMPLE_BOTH,
        'package.json': '{"name":"tmp","env-saaf":{"dir":"app"}}',
      });
      const r = run(['check'], dir);
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      // an explicit directory argument beats the config dir.
      const r2 = run(['check', 'app'], dir);
      assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
    }
    // unknown config keys, a non-object config and a malformed package.json
    // are usage errors (exit 2), never silently ignored.
    {
      const unknown = mkProject({ ...base, 'package.json': '{"name":"tmp","env-saaf":{"bogus":1}}' });
      const r = run(['check', unknown], unknown);
      assert.strictEqual(r.status, 2);
      assert.match(r.stderr, /unknown key.*bogus/);
      const notObj = mkProject({ ...base, 'package.json': '{"name":"tmp","env-saaf":"env.schema.js"}' });
      const r2 = run(['check', notObj], notObj);
      assert.strictEqual(r2.status, 2);
      assert.match(r2.stderr, /must be an object/);
      const broken = mkProject({ ...base, 'package.json': '{"name":' });
      const r3 = run(['check', broken], broken);
      assert.strictEqual(r3.status, 2);
      assert.match(r3.stderr, /cannot read project config/);
    }
    // print works from the config schema alone (it requires --schema).
    {
      const dir = mkProject({ ...base, 'package.json': '{"name":"tmp","env-saaf":{"schema":"env.schema.js"}}' });
      const r = run(['print', dir], dir);
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /PORT=3000/);
    }
  }

  // --- print: coerced values, defaults and masked sensitive rules (#353) ---
  {
    const schema = "module.exports = {\n"
      + "  PORT: { type: 'port', required: true },\n"
      + "  DEBUG: { type: 'boolean', default: false },\n"
      + "  API_TOKEN: { type: 'string', required: true, sensitive: true },\n"
      + "  DB: { prefix: 'DB_', schema: { HOST: { type: 'string', default: 'localhost' } } },\n"
      + "};\n";
    const dir = mkProject({
      'src/app.js': 'console.log(process.env.PORT);\n',
      'env.schema.js': schema,
      '.env': 'PORT=3000\nAPI_TOKEN=supersecretvalue\n',
      '.env.production': 'PORT=3100\nAPI_TOKEN=other-secret\n',
    });
    const text = run(['print', dir, '--schema', 'env.schema.js'], dir);
    assert.strictEqual(text.status, 0, text.stdout + text.stderr);
    assert.match(text.stdout, /^PORT=3000$/m);
    assert.match(text.stdout, /^DEBUG=false$/m);
    assert.match(text.stdout, /^DB_HOST=localhost$/m);
    assert.ok(!text.stdout.includes('supersecretvalue'), 'sensitive value leaked in text output');
    assert.match(text.stdout, /^API_TOKEN=su\*\*\*ue$/m);

    const json = JSON.parse(run(['print', dir, '--schema', 'env.schema.js', '--json'], dir).stdout);
    assert.strictEqual(json.PORT, 3000);
    assert.strictEqual(json.DEBUG, false);
    assert.strictEqual(json.DB.HOST, 'localhost');
    assert.notStrictEqual(json.API_TOKEN, 'supersecretvalue');
    assert.ok(!JSON.stringify(json).includes('supersecretvalue'));

    const other = JSON.parse(run(['print', dir, '--schema', 'env.schema.js', '--file', '.env.production', '--json'], dir).stdout);
    assert.strictEqual(other.PORT, 3100);
    assert.ok(!JSON.stringify(other).includes('other-secret'));

    fs.writeFileSync(path.join(dir, '.env'), 'PORT=nope\nAPI_TOKEN=x\n');
    const bad = run(['print', dir, '--schema', 'env.schema.js'], dir);
    assert.strictEqual(bad.status, 1);
    assert.match(bad.stderr, /PORT: expected a port/);
    const noSchema = run(['print', dir], dir);
    assert.strictEqual(noSchema.status, 2);
    assert.match(noSchema.stderr, /print needs --schema/);
    const noEnv = run(['print', dir, '--schema', 'env.schema.js', '--file', 'missing.env'], dir);
    assert.strictEqual(noEnv.status, 2);
    assert.match(noEnv.stderr, /missing\.env not found/);
  }

  // --- check --schema: schema vs example drift, both directions (#358) -----
  {
    const schema = "module.exports = {\n"
      + "  A: { type: 'string' },\n"
      + "  B: { type: 'string', default: 'x' },\n"
      + "  DB: { prefix: 'DB_', schema: { HOST: { type: 'string' }, PORT: { type: 'port', default: 3000 } } },\n"
      + "};\n";
    const dir = mkProject({
      'src/app.js': 'console.log(process.env.A, process.env.DB_HOST, process.env.C);\n',
      '.env.example': 'A=\nDB_HOST=\nC=\n',
      'env.schema.js': schema,
    });
    const r = run(['check', dir, '--schema', 'env.schema.js'], dir);
    assert.strictEqual(r.status, 1);
    assert.match(r.stdout, /NOT DOCUMENTED: B \(in schema, missing from \.env\.example\)/);
    assert.match(r.stdout, /NOT DOCUMENTED: DB_PORT \(in schema, missing from \.env\.example\)/);
    assert.match(r.stdout, /NOT IN SCHEMA: C \(in \.env\.example, not declared in the schema\)/);
    const j = JSON.parse(run(['check', dir, '--schema', 'env.schema.js', '--json'], dir).stdout);
    assert.deepStrictEqual(j.schemaNotDocumented.sort(), ['B', 'DB_PORT']);
    assert.deepStrictEqual(j.documentedNotInSchema, ['C']);

    // No drift: a grouped key documented in the example matches the schema.
    const clean = mkProject({
      'src/app.js': 'console.log(process.env.A, process.env.DB_HOST);\n',
      '.env.example': 'A=\nDB_HOST=\n',
      'env.schema.js': "module.exports = { A: { type: 'string' }, DB: { prefix: 'DB_', schema: { HOST: { type: 'string' } } } };\n",
    });
    const ok = run(['check', clean, '--schema', 'env.schema.js', '--json'], clean);
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    const parsed = JSON.parse(ok.stdout);
    assert.deepStrictEqual(parsed.schemaNotDocumented, []);
    assert.deepStrictEqual(parsed.documentedNotInSchema, []);

    // Without --schema the JSON shape is unchanged.
    const noSchema = JSON.parse(run(['check', dir, '--json'], dir).stdout);
    assert.ok(!('schemaNotDocumented' in noSchema) && !('documentedNotInSchema' in noSchema));

  }

  // --- check --json-schema: stdout is the draft 2020-12 JSON Schema for the --schema file (issue #268)
  {
    const { toJsonSchema } = require('./index');
    const schemaText = "module.exports = {\n"
      + "  PORT: { type: 'port', required: true },\n"
      + "  DATABASE_URL: { type: 'url' },\n"
      + "  MODE: { type: 'string', choices: ['dev', 'prod'], default: 'dev' },\n"
      + "  DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true }, PORT: { type: 'port', default: 5432 } } },\n"
      + "};\n";
    const dir = mkProject({
      'src/app.js': 'console.log(process.env.PORT, process.env.DATABASE_URL, process.env.MODE, process.env.DB_HOST, process.env.DB_PORT);\n',
      '.env.example': 'PORT=\nDATABASE_URL=\nMODE=\nDB_HOST=\nDB_PORT=\n',
      'env.schema.js': schemaText,
    });
    const expected = toJsonSchema(require(path.join(dir, 'env.schema.js')));
    const r = run(['check', dir, '--schema', 'env.schema.js', '--json-schema'], dir);
    assert.strictEqual(r.status, 0, `check --json-schema should exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.strictEqual(r.stderr, '', 'the schema document belongs on stdout, nothing on stderr');
    const parsed = JSON.parse(r.stdout); // must not throw
    assert.deepStrictEqual(parsed, expected);
    assert.strictEqual(parsed.$schema, 'https://json-schema.org/draft/2020-12/schema');
    // The grouped schema nests as an object schema (issue #262).
    assert.strictEqual(parsed.properties.DB.type, 'object');
    assert.deepStrictEqual(parsed.properties.DB.required, ['HOST']);
    // --schema= form and flag order do not matter.
    const r2 = run(['check', '--json-schema', '--schema=env.schema.js', dir], dir);
    assert.strictEqual(r2.status, 0, `${r2.stdout}${r2.stderr}`);
    assert.deepStrictEqual(JSON.parse(r2.stdout), expected);
    // Without the flag the normal check still runs (and passes here).
    const plain = run(['check', dir, '--schema', 'env.schema.js'], dir);
    assert.strictEqual(plain.status, 0, `plain check should still pass, got ${plain.status}: ${plain.stdout}${plain.stderr}`);
    assert.match(plain.stdout, /all clean/);
    // --json-schema without --schema exits 2 with a plain message.
    const noSchema = run(['check', dir, '--json-schema'], dir);
    assert.strictEqual(noSchema.status, 2);
    assert.match(noSchema.stderr, /--json-schema needs --schema/);
    // A missing schema file exits 2, no stack trace.
    const missing = run(['check', dir, '--schema', 'nope.js', '--json-schema'], dir);
    assert.strictEqual(missing.status, 2);
    assert.match(missing.stderr, /cannot load schema nope\.js/);
    assert.ok(!/at Object\.|at Module\./.test(missing.stderr), 'no raw Node stack trace');
  }

  // --- check: missing .env.example exits 2 with a hint ----------------------
  {
    const dir = mkProject({ 'src/app.js': SRC_WITH_USAGE });
    const r = run(['check', dir], dir);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /\.env\.example not found/);
    assert.match(r.stderr, /env-saaf example/);
  }

  // Issue #321: scanner results and template checks agree on quoted env keys.
  {
    const dir = mkProject({
      'src/app.js': "process.env['DB.PORT']; process.env[`MY-KEY`]; const { 'OTHER.KEY': x } = process.env;",
      '.env.example': 'DB.PORT=5432\nMY-KEY=hello\nOTHER.KEY=value\n',
    });
    const scan = run(['scan', dir, '--json'], dir);
    assert.strictEqual(scan.status, 0);
    assert.deepStrictEqual(JSON.parse(scan.stdout).vars, ['DB.PORT', 'MY-KEY', 'OTHER.KEY']);
    const check = run(['check', dir], dir);
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    assert.match(check.stdout, /all clean/);
  }

  // --- scan: lists used vars on stdout, exit 0 -------------------------------
  {
    const dir = mkProject({ 'src/app.js': SRC_WITH_USAGE, 'lib/util.js': 'module.exports = process.env.PORT;\n' });
    const r = run(['scan', dir], dir);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), 'DATABASE_URL\nPORT');
  }

  // --- scan --json on an empty project: ok with empty vars, note on stderr --
  {
    const dir = mkProject({ 'README.md': '# nothing here\n' });
    const r = run(['scan', dir, '--json'], dir);
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true, vars: [], locations: {} });
    const plain = run(['scan', dir], dir);
    assert.strictEqual(plain.status, 0);
    assert.match(plain.stderr, /No process\.env usage found\./);
  }

  // --- scan/check --exclude: repeatable names and globs (issue #355) --------
  {
    const dir = mkProject({
      'src/app.js': 'process.env.KEEP;\n',
      'fixtures/a.js': 'process.env.SKIP_FIXTURE;\n',
      'src/generated/g.js': 'process.env.SKIP_GENERATED;\n',
      '.env.example': 'KEEP=\n',
    });
    const all = JSON.parse(run(['scan', dir, '--json'], dir).stdout);
    assert.ok(all.vars.includes('SKIP_FIXTURE') && all.vars.includes('SKIP_GENERATED'));
    const excluded = JSON.parse(run(['scan', dir, '--exclude', 'fixtures', '--exclude', 'src/generated/**', '--json'], dir).stdout);
    assert.deepStrictEqual(excluded.vars, ['KEEP']);
    assert.ok(!('excluded' in excluded), 'JSON shape is unchanged');
    const check = run(['check', dir, '--exclude', 'fixtures', '--exclude', 'src/generated/**'], dir);
    assert.strictEqual(check.status, 0, check.stdout + check.stderr);
    const noValue = run(['scan', dir, '--exclude'], dir);
    assert.strictEqual(noValue.status, 2);
    assert.match(noValue.stderr, /--exclude needs a value/);
  }

  // --- scan: UNUSED warnings go to stderr and never change the exit code -----
  {
    const dir = mkProject({ 'src/app.js': SRC_WITH_USAGE, '.env.example': EXAMPLE_BOTH + 'LEGACY_KEY=\n' });
    const r = run(['scan', dir], dir);
    assert.strictEqual(r.status, 0);
    assert.match(r.stderr, /UNUSED: LEGACY_KEY/);
    assert.strictEqual(r.stdout.trim(), 'DATABASE_URL\nPORT');
  }

  // --- example --write: creates the file, then refuses without --force ------
  {
    const dir = mkProject({ 'src/app.js': SRC_WITH_USAGE });
    const w = run(['example', dir, '--write'], dir);
    assert.strictEqual(w.status, 0);
    const written = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    assert.match(written, /^DATABASE_URL=$/m);
    assert.match(written, /^PORT=$/m);
    const again = run(['example', dir, '--write'], dir);
    assert.strictEqual(again.status, 1, 'refuses to overwrite');
    assert.match(again.stderr, /already exist/);
    const forced = run(['example', dir, '--write', '--force'], dir);
    assert.strictEqual(forced.status, 0);
  }

  // --- example --write on a project with no usage: refuses, writes nothing ---
  {
    const dir = mkProject({ 'README.md': 'no code\n' });
    const r = run(['example', dir, '--write'], dir);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /nothing to write/);
    assert.ok(!fs.existsSync(path.join(dir, '.env.example')));
  }

  // --- init -> check round-trip in a CommonJS project ------------------------
  {
    const dir = mkProject({ 'src/app.js': SRC_WITH_USAGE, 'package.json': '{"name":"tmp-cjs"}\n' });
    const init = run(['init', dir], dir);
    assert.strictEqual(init.status, 0, init.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'env.schema.js')), 'CJS project gets env.schema.js');
    assert.ok(fs.existsSync(path.join(dir, '.env.example')));
    // The scanned keys are folded into the scaffold (issue #171), so the
    // post-init check reports no MISSING lines; the scaffold's own fixed keys
    // are still UNUSED until code reads them, which fails the check per #113.
    const example = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    assert.match(example, /^PORT=/m);
    assert.match(example, /^DATABASE_URL=/m);
    const check = run(['check', dir, '--schema', 'env.schema.js'], dir);
    assert.ok(!/MISSING/.test(check.stdout), `no MISSING after init: ${check.stdout}`);
    assert.match(check.stdout, /UNUSED: APP_NAME/);
    // init refuses to overwrite without --force
    const again = run(['init', dir], dir);
    assert.strictEqual(again.status, 1);
    assert.match(again.stderr, /already exist/);
  }

  // --- init -> check round-trip in a "type": "module" project (issue #184) ---
  {
    const dir = mkProject({
      'package.json': '{"name":"tmp-esm","type":"module"}\n',
      'src/app.js': SRC_WITH_USAGE,
    });
    const init = run(['init', dir], dir);
    assert.strictEqual(init.status, 0, init.stderr);
    assert.ok(fs.existsSync(path.join(dir, 'env.schema.cjs')), 'ESM project gets env.schema.cjs');
    assert.ok(!fs.existsSync(path.join(dir, 'env.schema.js')));
    const check = run(['check', dir, '--schema', 'env.schema.cjs'], dir);
    assert.ok(!/MISSING/.test(check.stdout), `no MISSING after init in ESM project: ${check.stdout}`);
  }

  // --- missing directory: exit 2, clear message, no stack trace --------------
  {
    const dir = mkProject({});
    const missing = path.join(dir, 'nope');
    const r = run(['check', missing], dir);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /does not exist/);
    assert.ok(!/at Object\.|at Module\./.test(r.stderr), 'no raw Node stack trace');
    const rj = run(['scan', missing, '--json'], dir);
    assert.strictEqual(rj.status, 2);
    assert.strictEqual(JSON.parse(rj.stdout).ok, false);
  }

  // --- global flags: --version exits 0 before any command --------------------
  {
    const dir = mkProject({});
    const v = run(['--version'], dir);
    assert.strictEqual(v.status, 0);
    assert.match(v.stdout, /^env-saaf \d+\.\d+\.\d+/);
    const after = run(['check', dir, '--version'], dir);
    assert.strictEqual(after.status, 0);
    assert.match(after.stdout, /^env-saaf /);
  }

  // --- unknown command prints usage and exits 2 -------------------------------
  {
    const dir = mkProject({});
    const r = run(['frobnicate', dir], dir);
    assert.strictEqual(r.status, 2);
    assert.match(r.stdout, /Usage: env-saaf/);
  }

  // --- the assertions are real: a deliberately wrong exit-code expectation fails
  {
    const dir = mkProject({ 'src/app.js': SRC_WITH_USAGE, '.env.example': EXAMPLE_BOTH });
    const r = run(['check', dir], dir);
    assert.throws(
      () => assert.strictEqual(r.status, 99, 'deliberately wrong expectation'),
      /deliberately wrong expectation/,
    );
  }

  // --- issue #232: init --from-example infers a schema from an existing example
  {
    const example = [
      'APP_NAME=demo-app',
      'PORT=5432',
      'DEBUG=true',
      'API_URL=https://api.example.com/v1',
      'SUPPORT_EMAIL=admin@example.com',
      'RETRIES=3',
      'RATIO=2.5',
      'EMPTY=',
      'DB_HOST=db.internal',
      '',
    ].join('\n');
    const allKeys = 'console.log(' + ['APP_NAME','PORT','DEBUG','API_URL','SUPPORT_EMAIL','RETRIES','RATIO','EMPTY','DB_HOST'].map(k => `process.env.${k}`).join(', ') + ');\n';
    const dir = mkProject({ '.env.example': example, 'src/app.js': allKeys });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 0, `init --from-example should exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /wrote env\.schema\.js inferred from \.env\.example \(9 variables\)/);
    assert.match(r.stdout, /\.env\.example left untouched/);

    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    // Each inferred type is present, with an "inferred ... review" comment.
    for (const [key, type] of [['APP_NAME', 'string'], ['PORT', 'port'], ['DEBUG', 'boolean'], ['API_URL', 'url'], ['SUPPORT_EMAIL', 'email'], ['RETRIES', 'int'], ['RATIO', 'number'], ['EMPTY', 'string'], ['DB_HOST', 'string']]) {
      const ci = schemaText.indexOf(`inferred as '${type}' from the sample value in .env.example`);
      const ki = schemaText.indexOf(`${key}: { type: '${type}' }`);
      assert.ok(ci !== -1 && ki !== -1 && ci < ki, `missing inferred rule for ${key}`);
    }
    // The sample values themselves are never echoed into comments (a password
    // in the example must not leak into the committed schema).
    assert.ok(!schemaText.includes('demo-app'), 'sample value leaked into schema comment');
    // PORT is in the example, so the scan did not duplicate it.
    assert.strictEqual(schemaText.match(/PORT: \{ type: 'port' \}/g).length, 1);
    // The example file is byte-for-byte untouched.
    assert.strictEqual(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), example);
    // Acceptance: the generated schema's check passes against that same example file.
    const c = run(['check', dir, '--file', '.env.example', '--schema', 'env.schema.js'], dir);
    assert.strictEqual(c.status, 0, `check against the example should pass, got ${c.status}: ${c.stdout}${c.stderr}`);
  }

  // --- issue #290: inferred schemas keep dotted and dashed names as usable flat keys
  {
    const dir = mkProject({ '.env.example': 'DB.PORT=5432\nMY-KEY=demo\nA.B-C_D=3\n' });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);

    const schema = require(path.join(dir, 'env.schema.js'));
    assert.deepStrictEqual(schema, {
      'DB.PORT': { type: 'port' }, 'MY-KEY': { type: 'string' }, 'A.B-C_D': { type: 'int' },
    });
    const { loadEnv } = require('./index');
    assert.deepStrictEqual(loadEnv(schema, { path: path.join(dir, '.env.example'), env: {} }), {
      'DB.PORT': 5432, 'MY-KEY': 'demo', 'A.B-C_D': 3,
    });
    const c = run(['check', dir, '--file', '.env.example', '--schema', 'env.schema.js'], dir);
    assert.strictEqual(c.status, 0, `${c.stdout}${c.stderr}`);
  }

  // --- issue #232: a scanned key the example lacks is folded in as a string rule
  {
    const dir = mkProject({ '.env.example': 'PORT=8080\n', 'src/app.js': 'console.log(process.env.EXTRA_SCANNED);\n' });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /folded in 1 key found by scanning the code: EXTRA_SCANNED/);
    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    assert.match(schemaText, /EXTRA_SCANNED: \{ type: 'string' \}/);
    assert.strictEqual(schemaText.match(/PORT: \{ type: 'port' \}/g).length, 1);
  }

  // --- issue #232: port-looking threshold — 1024..65535 is a port, smaller ints are int
  {
    const dir = mkProject({ '.env.example': 'A=1024\nB=65535\nC=1023\nD=65536\nE=-5\n' });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    assert.match(schemaText, /A: \{ type: 'port' \}/);
    assert.match(schemaText, /B: \{ type: 'port' \}/);
    assert.match(schemaText, /C: \{ type: 'int' \}/);
    assert.match(schemaText, /D: \{ type: 'int' \}/);
    assert.match(schemaText, /E: \{ type: 'int' \}/);
  }

  // --- issue #232 (review fix): malformed samples must not infer 'email'/'url' —
  // the generated schema has to validate against the example's own values.
  {
    const dir = mkProject({ '.env.example': 'BAD_EMAIL=a@.b.com\nBAD_URL=http://host:abc\nGOOD_EMAIL=admin@example.com\nGOOD_URL=https://api.example.com/v1\n' });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    // 'a@.b.com' has a domain starting with a dot and 'http://host:abc' has an
    // invalid port — both fail the corresponding validators, so they infer 'string'.
    assert.match(schemaText, /BAD_EMAIL: \{ type: 'string' \}/);
    assert.match(schemaText, /BAD_URL: \{ type: 'string' \}/);
    assert.doesNotMatch(schemaText, /BAD_EMAIL: \{ type: 'email' \}/);
    assert.doesNotMatch(schemaText, /BAD_URL: \{ type: 'url' \}/);
    // Valid samples still infer their types.
    assert.match(schemaText, /GOOD_EMAIL: \{ type: 'email' \}/);
    assert.match(schemaText, /GOOD_URL: \{ type: 'url' \}/);
    // Acceptance: check passes against the example's own values.
    const c = run(['check', dir, '--file', '.env.example', '--schema', 'env.schema.js'], dir);
    assert.strictEqual(c.status, 0, `check against the example should pass, got ${c.status}: ${c.stdout}${c.stderr}`);
  }

  // --- issue #232: --from-example=FILE names a different example file
  {
    const dir = mkProject({ '.env.sample': 'TOKEN=abc123\n' });
    const r = run(['init', dir, '--from-example=.env.sample'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /inferred from \.env\.sample \(1 variable\)/);
    assert.ok(fs.existsSync(path.join(dir, 'env.schema.js')));
    assert.ok(!fs.existsSync(path.join(dir, '.env.example')), 'no .env.example should be created in --from-example mode');
  }

  // --- issue #232: missing example file exits 2 and writes nothing
  {
    const dir = mkProject({ 'src/app.js': 'console.log(process.env.PORT);\n' });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /\.env\.example not found/);
    assert.ok(!fs.existsSync(path.join(dir, 'env.schema.js')));
  }

  // --- issue #232: existing schema without --force refuses (exit 1); --force overwrites schema but not the example
  {
    const example = 'PORT=8080\n';
    const dir = mkProject({ '.env.example': example, 'env.schema.js': 'module.exports = {};\n' });
    const r1 = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r1.status, 1);
    assert.match(r1.stderr, /env\.schema\.js already exists/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8'), 'module.exports = {};\n');
    const r2 = run(['init', dir, '--from-example', '--force'], dir);
    assert.strictEqual(r2.status, 0, `${r2.stdout}${r2.stderr}`);
    assert.match(fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8'), /PORT: \{ type: 'port' \}/);
    assert.strictEqual(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), example);
  }

  // --- issue #232: in a "type": "module" project the inferred schema is a .cjs file
  {
    const dir = mkProject({ 'package.json': '{"type":"module"}\n', '.env.example': 'PORT=8080\n' });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.ok(fs.existsSync(path.join(dir, 'env.schema.cjs')), 'ESM project should get env.schema.cjs');
    assert.match(fs.readFileSync(path.join(dir, 'env.schema.cjs'), 'utf8'), /PORT: \{ type: 'port' \}/);
  }

  // --- issue #232: without --from-example, init behaves exactly as before (writes both files)
  {
    const dir = mkProject({ 'src/app.js': SRC_WITH_USAGE });
    const r = run(['init', dir], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /wrote env\.schema\.js and \.env\.example/);
    assert.ok(fs.existsSync(path.join(dir, '.env.example')));
    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    for (const k of ['APP_NAME', 'RETRIES', 'DEBUG', 'PORT', 'API_URL', 'SUPPORT_EMAIL', 'SHUTDOWN_TIMEOUT', 'DB_HOST']) {
      assert.match(schemaText, new RegExp(`${k}: \\{`), `fixed scaffold key ${k} missing`);
    }
    assert.match(schemaText, /DATABASE_URL: \{ type: 'string' \}/);
  }

  // --- issue #263: init --from-example --groups folds keys sharing a prefix into a grouped schema
  {
    const example = [
      'DB_HOST=localhost',
      'DB_PORT=5432',
      'DB_USER=app',
      'API_KEY=secret_token',
      '',
    ].join('\n');
    const dir = mkProject({ '.env.example': example });
    const r = run(['init', dir, '--from-example', '--groups'], dir);
    assert.strictEqual(r.status, 0, `init --from-example --groups should exit 0, got ${r.status}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /\.env\.example left untouched/);

    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    // Group DB with prefix 'DB_' and inner rules HOST, PORT, USER
    assert.match(schemaText, /DB: \{\s+prefix: 'DB_',\s+schema: \{/);
    assert.match(schemaText, /HOST: \{ type: 'string' \}/);
    assert.match(schemaText, /PORT: \{ type: 'port' \}/);
    assert.match(schemaText, /USER: \{ type: 'string' \}/);
    // API_KEY stays flat
    assert.match(schemaText, /API_KEY: \{ type: 'string' \}/);
    assert.doesNotMatch(schemaText, /API: \{\s+prefix:/);
    // Comments on inferred rules
    assert.ok(schemaText.includes("inferred as 'port' from the sample value in .env.example — review this rule"));
    assert.ok(schemaText.includes("inferred as 'string' from the sample value in .env.example — review this rule"));
    // The example file is byte-for-byte untouched
    assert.strictEqual(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), example);

    // Acceptance: the generated schema's check passes against that same example file
    const c = run(['check', dir, '--file', '.env.example', '--schema', 'env.schema.js'], dir);
    assert.strictEqual(c.status, 0, `check against the example should pass, got ${c.status}: ${c.stdout}${c.stderr}`);
  }

  // --- issue #263: without --groups, behavior is unchanged (flat rules)
  {
    const example = [
      'DB_HOST=localhost',
      'DB_PORT=5432',
      'DB_USER=app',
      'API_KEY=secret_token',
      '',
    ].join('\n');
    const dir = mkProject({ '.env.example': example });
    const r = run(['init', dir, '--from-example'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    assert.doesNotMatch(schemaText, /prefix: 'DB_'/);
    assert.match(schemaText, /DB_HOST: \{ type: 'string' \}/);
    assert.match(schemaText, /DB_PORT: \{ type: 'port' \}/);
    assert.match(schemaText, /DB_USER: \{ type: 'string' \}/);
    assert.match(schemaText, /API_KEY: \{ type: 'string' \}/);
  }

  // --- issue #263: a single key with a prefix stays flat even with --groups
  {
    const example = [
      'DB_HOST=localhost',
      'API_KEY=secret_token',
      '',
    ].join('\n');
    const dir = mkProject({ '.env.example': example });
    const r = run(['init', dir, '--from-example', '--groups'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    assert.doesNotMatch(schemaText, /prefix:/);
    assert.match(schemaText, /DB_HOST: \{ type: 'string' \}/);
    assert.match(schemaText, /API_KEY: \{ type: 'string' \}/);
  }

  // --- issue #263: one-character prefix (A_X, A_Y) does not become a group even with --groups
  {
    const example = [
      'A_X=1024',
      'A_Y=2048',
      '',
    ].join('\n');
    const dir = mkProject({ '.env.example': example });
    const r = run(['init', dir, '--from-example', '--groups'], dir);
    assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
    const schemaText = fs.readFileSync(path.join(dir, 'env.schema.js'), 'utf8');
    assert.doesNotMatch(schemaText, /prefix:/);
    assert.match(schemaText, /A_X: \{ type: 'port' \}/);
    assert.match(schemaText, /A_Y: \{ type: 'port' \}/);
  }

  // --- issue #278: unknown and misplaced flags fail fast with exit 2
  {
    const dir = mkProject({ 'app.js': 'process.env.PORT;\n', '.env.example': 'PORT=3000\n' });
    const unknown = run(['check', dir, '--bogus'], dir);
    assert.strictEqual(unknown.status, 2);
    assert.match(unknown.stderr, /unknown flag --bogus for check/);
    const misplaced = run(['scan', dir, '--json-schema'], dir);
    assert.strictEqual(misplaced.status, 2);
    assert.match(misplaced.stderr, /flag --json-schema is not supported for scan/);
    const exJson = run(['example', dir, '--json'], dir);
    assert.strictEqual(exJson.status, 2);
    const exWatch = run(['example', dir, '--watch'], dir);
    assert.strictEqual(exWatch.status, 2);
    const initJson = run(['init', dir, '--json'], dir);
    assert.strictEqual(initJson.status, 2);
    const valueless = run(['check', dir, '--file'], dir);
    assert.strictEqual(valueless.status, 2);
    assert.match(valueless.stderr, /--file needs a value/);
    // Valid combinations keep working:
    const okJson = run(['scan', dir, '--json'], dir);
    assert.strictEqual(okJson.status, 0, `${okJson.stdout}${okJson.stderr}`);
    const okCheck = run(['check', dir, '--json'], dir);
    assert.strictEqual(okCheck.status, 0, `${okCheck.stdout}${okCheck.stderr}`);
  }

  // --- issue #285: ESM schema loading (export default, named exports, CJS preservation, true errors)
  {
    const { toJsonSchema } = require('./index');
    const expected = toJsonSchema({ PORT: { type: 'port', required: true }, MODE: { type: 'string', default: 'dev' } });

    // 1. .mjs schema with sole `export default` works across check --json-schema, check, and example --schema.
    const mjsDir = mkProject({
      'src/app.js': 'console.log(process.env.PORT, process.env.MODE);\n',
      '.env.example': 'PORT=\nMODE=\n',
      '.env': 'PORT=3000\nMODE=dev\n',
      'env.schema.mjs': "export default { PORT: { type: 'port', required: true }, MODE: { type: 'string', default: 'dev' } };\n",
    });
    const jsSchemaOut = run(['check', mjsDir, '--schema', 'env.schema.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(jsSchemaOut.status, 0, `${jsSchemaOut.stdout}${jsSchemaOut.stderr}`);
    assert.strictEqual(jsSchemaOut.stderr, '');
    assert.deepStrictEqual(JSON.parse(jsSchemaOut.stdout), expected);

    const okCheck = run(['check', mjsDir, '--schema', 'env.schema.mjs'], mjsDir);
    assert.strictEqual(okCheck.status, 0, `${okCheck.stdout}${okCheck.stderr}`);
    assert.match(okCheck.stdout, /all clean/);

    fs.writeFileSync(path.join(mjsDir, '.env'), 'PORT=not-a-port\nMODE=dev\n');
    const badVal = run(['check', mjsDir, '--schema', 'env.schema.mjs'], mjsDir);
    assert.strictEqual(badVal.status, 1);
    assert.match(badVal.stdout, /INVALID: PORT:/);
    assert.doesNotMatch(badVal.stdout + badVal.stderr, /default: unknown option/);

    const badValJson = run(['check', mjsDir, '--schema', 'env.schema.mjs', '--json'], mjsDir);
    assert.strictEqual(badValJson.status, 1);
    const parsedBad = JSON.parse(badValJson.stdout);
    assert.strictEqual(parsedBad.ok, false);
    assert.ok(parsedBad.invalid.some(e => /^PORT:/.test(e)));

    const exOut = run(['example', mjsDir, '--schema', 'env.schema.mjs'], mjsDir);
    assert.strictEqual(exOut.status, 0, `${exOut.stdout}${exOut.stderr}`);
    assert.match(exOut.stdout, /PORT=3000/);
    assert.match(exOut.stdout, /MODE=dev/);
    assert.doesNotMatch(exOut.stdout, /^default=/m);
    const exWrite = run(['example', mjsDir, '--schema', 'env.schema.mjs', '--write', '--force'], mjsDir);
    assert.strictEqual(exWrite.status, 0, `${exWrite.stdout}${exWrite.stderr}`);
    assert.match(exWrite.stdout, /wrote \.env\.example \(2 variables\)/);

    // 2. .js schema inside a "type": "module" project with `export default`.
    const pkgEsmDir = mkProject({
      'package.json': '{"name":"esm-pkg","type":"module"}\n',
      'src/app.js': 'console.log(process.env.PORT, process.env.MODE);\n',
      '.env.example': 'PORT=\nMODE=\n',
      '.env': 'PORT=8080\nMODE=dev\n',
      'env.schema.js': "export default { PORT: { type: 'port', required: true }, MODE: { type: 'string', default: 'dev' } };\n",
    });
    const pkgJsSchema = run(['check', pkgEsmDir, '--schema', 'env.schema.js', '--json-schema'], pkgEsmDir);
    assert.strictEqual(pkgJsSchema.status, 0, `${pkgJsSchema.stdout}${pkgJsSchema.stderr}`);
    assert.deepStrictEqual(JSON.parse(pkgJsSchema.stdout), expected);
    const pkgCheck = run(['check', pkgEsmDir, '--schema', 'env.schema.js'], pkgEsmDir);
    assert.strictEqual(pkgCheck.status, 0, `${pkgCheck.stdout}${pkgCheck.stderr}`);
    const pkgEx = run(['example', pkgEsmDir, '--schema', 'env.schema.js'], pkgEsmDir);
    assert.strictEqual(pkgEx.status, 0, `${pkgEx.stdout}${pkgEx.stderr}`);
    assert.match(pkgEx.stdout, /PORT=3000/);

    // 3. Top-level await in .mjs (exercises dynamic import() even when require(esm) exists).
    fs.writeFileSync(path.join(mjsDir, 'async.schema.mjs'),
      "const schema = await Promise.resolve({ PORT: { type: 'port', required: true }, MODE: { type: 'string', default: 'dev' } });\nexport default schema;\n");
    const asyncOut = run(['check', mjsDir, '--schema', 'async.schema.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(asyncOut.status, 0, `${asyncOut.stdout}${asyncOut.stderr}`);
    assert.deepStrictEqual(JSON.parse(asyncOut.stdout), expected);

    // 4. Invalid rule inside `export default` still reports the real schema error.
    fs.writeFileSync(path.join(mjsDir, 'bad-rule.mjs'), "export default { PORT: { type: 'bogus' } };\n");
    const badRule = run(['check', mjsDir, '--schema', 'bad-rule.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(badRule.status, 2);
    assert.match(badRule.stderr, /PORT: unknown type "bogus"/);
    assert.doesNotMatch(badRule.stderr, /default: unknown option/);

    // 5. Non-plain default exports in ESM fail with `must export a schema object`.
    for (const [name, src] of [
      ['null.mjs', 'export default null;\n'],
      ['str.mjs', "export default 'nope';\n"],
      ['arr.mjs', "export default ['PORT'];\n"],
      ['date.mjs', 'export default new Date();\n'],
    ]) {
      fs.writeFileSync(path.join(mjsDir, name), src);
      const r = run(['check', mjsDir, '--schema', name, '--json-schema'], mjsDir);
      assert.strictEqual(r.status, 2, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /must export a schema object/, name);
    }

    // 6. ESM named exports work (single or multiple); mixed default + named or explicit __esModule + default do not unwrap.
    fs.writeFileSync(path.join(mjsDir, 'single-named.mjs'),
      "export const PORT = { type: 'port', required: true };\n");
    const singleNamed = run(['check', mjsDir, '--schema', 'single-named.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(singleNamed.status, 0, `${singleNamed.stdout}${singleNamed.stderr}`);
    assert.deepStrictEqual(JSON.parse(singleNamed.stdout).properties, { PORT: expected.properties.PORT });

    fs.writeFileSync(path.join(mjsDir, 'named.mjs'),
      "export const PORT = { type: 'port', required: true };\nexport const MODE = { type: 'string', default: 'dev' };\n");
    const namedJs = run(['check', mjsDir, '--schema', 'named.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(namedJs.status, 0, `${namedJs.stdout}${namedJs.stderr}`);
    assert.deepStrictEqual(JSON.parse(namedJs.stdout), expected);
    const namedEx = run(['example', mjsDir, '--schema', 'named.mjs'], mjsDir);
    assert.strictEqual(namedEx.status, 0, `${namedEx.stdout}${namedEx.stderr}`);
    assert.match(namedEx.stdout, /PORT=3000/);

    fs.writeFileSync(path.join(mjsDir, 'mixed.mjs'),
      "export default { PORT: { type: 'port', required: true } };\nexport const EXTRA = { type: 'string' };\n");
    const mixed = run(['check', mjsDir, '--schema', 'mixed.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(mixed.status, 2);
    assert.match(mixed.stderr, /default: unknown option "PORT"/);

    fs.writeFileSync(path.join(mjsDir, 'esmod-named.mjs'),
      "export const __esModule = true;\nexport default { PORT: { type: 'port', required: true } };\n");
    const esmodNamed = run(['check', mjsDir, '--schema', 'esmod-named.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(esmodNamed.status, 2);
    assert.match(esmodNamed.stderr, /default: unknown option "PORT"/);

    // 7. CommonJS schemas stay untouched, including an actual key named `default` and CJS `__esModule`.
    const cjsDir = mkProject({
      'src/app.js': 'console.log(process.env.default, process.env.PORT);\n',
      '.env.example': 'default=\nPORT=\n',
      '.env': 'default=hello\nPORT=3000\n',
      'cjs-default.cjs': "module.exports = { default: { type: 'string', required: true }, PORT: { type: 'port', required: true } };\n",
      'cjs-esmod.cjs': "module.exports = { __esModule: true, default: { PORT: { type: 'port', required: true } } };\n",
    });
    const cjsDefJs = run(['check', cjsDir, '--schema', 'cjs-default.cjs', '--json-schema'], cjsDir);
    assert.strictEqual(cjsDefJs.status, 0, `${cjsDefJs.stdout}${cjsDefJs.stderr}`);
    const cjsParsed = JSON.parse(cjsDefJs.stdout);
    assert.deepStrictEqual(cjsParsed.properties.default, { type: 'string' });
    assert.deepStrictEqual(cjsParsed.required, ['default', 'PORT']);

    const cjsDefCheck = run(['check', cjsDir, '--schema', 'cjs-default.cjs'], cjsDir);
    assert.strictEqual(cjsDefCheck.status, 0, `${cjsDefCheck.stdout}${cjsDefCheck.stderr}`);
    fs.writeFileSync(path.join(cjsDir, '.env'), 'PORT=3000\n');
    const cjsDefMissing = run(['check', cjsDir, '--schema', 'cjs-default.cjs'], cjsDir);
    assert.strictEqual(cjsDefMissing.status, 1);
    assert.match(cjsDefMissing.stdout, /INVALID: default: missing required variable/);
    const cjsDefEx = run(['example', cjsDir, '--schema', 'cjs-default.cjs'], cjsDir);
    assert.strictEqual(cjsDefEx.status, 0, `${cjsDefEx.stdout}${cjsDefEx.stderr}`);
    assert.match(cjsDefEx.stdout, /^default=your_value_here$/m);

    const cjsEsmod = run(['check', cjsDir, '--schema', 'cjs-esmod.cjs', '--json-schema'], cjsDir);
    assert.strictEqual(cjsEsmod.status, 2);
    assert.match(cjsEsmod.stderr, /default: unknown option "PORT"/);

    // 7b. Unwrapping sole `default` in ESM happens once, so an ESM schema with an actual `default` key works too.
    fs.writeFileSync(path.join(mjsDir, 'esm-default-key.mjs'),
      "export default { default: { type: 'string', required: true } };\n");
    const esmDefKey = run(['check', mjsDir, '--schema', 'esm-default-key.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(esmDefKey.status, 0, `${esmDefKey.stdout}${esmDefKey.stderr}`);
    assert.deepStrictEqual(JSON.parse(esmDefKey.stdout).properties.default, { type: 'string' });

    // 7c. On Node versions with require(esm), detected-ESM .js files (no "type": "module") and top-level await work too.
    if (process.features && process.features.require_module) {
      fs.writeFileSync(path.join(cjsDir, 'detected-esm.js'),
        "export default { PORT: { type: 'port', required: true }, MODE: { type: 'string', default: 'dev' } };\n");
      const detOut = run(['check', cjsDir, '--schema', 'detected-esm.js', '--json-schema'], cjsDir);
      assert.strictEqual(detOut.status, 0, `${detOut.stdout}${detOut.stderr}`);
      assert.deepStrictEqual(JSON.parse(detOut.stdout), expected);

      fs.writeFileSync(path.join(cjsDir, 'detected-async-esm.js'),
        "const s = await Promise.resolve({ PORT: { type: 'port', required: true }, MODE: { type: 'string', default: 'dev' } });\nexport default s;\n");
      const detAsyncOut = run(['check', cjsDir, '--schema', 'detected-async-esm.js', '--json-schema'], cjsDir);
      assert.strictEqual(detAsyncOut.status, 0, `${detAsyncOut.stdout}${detAsyncOut.stderr}`);
      assert.deepStrictEqual(JSON.parse(detAsyncOut.stdout), expected);
    }

    // 8. True module errors (syntax error, runtime throw, CJS syntax in ESM .js) are preserved.
    fs.writeFileSync(path.join(mjsDir, 'syntax.mjs'), 'export default {{{\n');
    const synErr = run(['check', mjsDir, '--schema', 'syntax.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(synErr.status, 2);
    assert.match(synErr.stderr, /cannot load schema syntax\.mjs/);

    fs.writeFileSync(path.join(mjsDir, 'boom.mjs'), "throw new Error('boom from esm schema');\n");
    const runErr = run(['check', mjsDir, '--schema', 'boom.mjs', '--json-schema'], mjsDir);
    assert.strictEqual(runErr.status, 2);
    assert.match(runErr.stderr, /cannot load schema boom\.mjs/);
    assert.match(runErr.stderr, /boom from esm schema/);

    fs.writeFileSync(path.join(pkgEsmDir, 'cjs-in-esm.js'), "module.exports = { PORT: { type: 'port' } };\n");
    const cjsInEsm = run(['check', pkgEsmDir, '--schema', 'cjs-in-esm.js'], pkgEsmDir);
    assert.strictEqual(cjsInEsm.status, 2);
    assert.match(cjsInEsm.stderr, /\.cjs/);
    assert.ok(!cjsInEsm.stderr.includes('ReferenceError'), cjsInEsm.stderr);

    fs.writeFileSync(path.join(cjsDir, 'throw-null.cjs'), 'throw null;\n');
    const nullThrow = run(['check', cjsDir, '--schema', 'throw-null.cjs', '--json-schema'], cjsDir);
    assert.strictEqual(nullThrow.status, 2);
    assert.match(nullThrow.stderr, /cannot load schema throw-null\.cjs: null/);
  }

  // --- issue #359: scan --stdin reads piped code via scanCode ----------------
  {
    const { scanCode, scanCodeLocations } = require('./index');
    const { spawn } = require('node:child_process');
    const dir = mkProject({
      'src/disk.js': 'console.log(process.env.DISK_ONLY_KEY);\n',
      '.env.example': 'PORT=\nCWD_TEMPLATE_UNUSED=\n',
    });
    const piped = [
      '// process.env.COMMENT_DECOY',
      '/* import.meta.env.BLOCK_DECOY */',
      "const literal = 'process.env.STRING_DECOY';",
      'const port = process.env.PORT;',
      "const host = process.env['DB.HOST'];",
      'const opt = process.env?.OPTIONAL_KEY;',
      'const vite = import.meta.env.VITE_API_URL;',
      "const { SECRET_TOKEN, RETRIES: r = '3' } = process.env;",
      'const env = process.env; const aliased = env.ALIAS_KEY;',
      'const tpl = `plain process.env.TPL_DECOY ${process.env.TPL_READ}`;',
      '',
    ].join('\n');
    const expectedVars = scanCode(piped);
    assert.deepStrictEqual(expectedVars, [
      'ALIAS_KEY', 'DB.HOST', 'OPTIONAL_KEY', 'PORT', 'RETRIES', 'SECRET_TOKEN', 'TPL_READ', 'VITE_API_URL',
    ]);

    // Text mode: prints the exact sorted scanCode keys, ignores disk files and implicit cwd .env.example.
    const plain = run(['scan', '--stdin'], dir, piped);
    assert.strictEqual(plain.status, 0, `${plain.stdout}${plain.stderr}`);
    assert.strictEqual(plain.stderr, '');
    assert.strictEqual(plain.stdout, expectedVars.join('\n') + '\n');

    // JSON mode (both flag orders): vars + locations from scanCodeLocations; no implicit cwd template noise.
    const expectedStdinJson = scanCodeLocations(piped, '-');
    for (const args of [['scan', '--stdin', '--json'], ['scan', '--json', '--stdin']]) {
      const js = run(args, dir, piped);
      assert.strictEqual(js.status, 0, `${js.stdout}${js.stderr}`);
      assert.strictEqual(js.stderr, '');
      assert.deepStrictEqual(JSON.parse(js.stdout), {
        ok: true,
        vars: expectedVars,
        locations: expectedStdinJson.locations,
      });
    }

    // Explicit --file compares stdin keys against the named template file.
    const withFile = run(['scan', '--stdin', '--file', '.env.example', '--json'], dir, 'process.env.PORT;\n');
    assert.strictEqual(withFile.status, 0, `${withFile.stdout}${withFile.stderr}`);
    assert.deepStrictEqual(JSON.parse(withFile.stdout), {
      ok: true,
      vars: ['PORT'],
      unused: ['CWD_TEMPLATE_UNUSED'],
      locations: { PORT: [{ file: '-', line: 1 }] },
    });

    // Empty stdin and comment-only stdin print existing no-usage output rather than hanging or crashing.
    for (const emptyInput of ['', '   \n', '// process.env.IGNORED\nconst x = 1;\n']) {
      const emptyPlain = run(['scan', '--stdin'], dir, emptyInput);
      assert.strictEqual(emptyPlain.status, 0);
      assert.strictEqual(emptyPlain.stdout, '');
      assert.strictEqual(emptyPlain.stderr, 'No process.env usage found.\n');

      const emptyJson = run(['scan', '--stdin', '--json'], dir, emptyInput);
      assert.strictEqual(emptyJson.status, 0);
      assert.strictEqual(emptyJson.stderr, '');
      assert.deepStrictEqual(JSON.parse(emptyJson.stdout), { ok: true, vars: [], locations: {} });
    }

    // Combining --stdin with a directory argument exits 2 with a clear message (text and --json).
    for (const args of [['scan', '--stdin', dir], ['scan', dir, '--stdin'], ['scan', '--stdin', '.']]) {
      const badDir = run(args, dir, piped);
      assert.strictEqual(badDir.status, 2, args.join(' '));
      assert.strictEqual(badDir.stdout, '');
      assert.match(badDir.stderr, /^env-saaf: --stdin cannot be combined with a directory argument\r?\n$/);
    }
    const badDirJson = run(['scan', '--stdin', dir, '--json'], dir, piped);
    assert.strictEqual(badDirJson.status, 2);
    assert.strictEqual(badDirJson.stderr, '');
    assert.deepStrictEqual(JSON.parse(badDirJson.stdout), {
      ok: false,
      error: 'env-saaf: --stdin cannot be combined with a directory argument',
    });

    // Combining --stdin with --watch or passing --stdin to other commands exits 2 cleanly.
    const badWatch = run(['scan', '--stdin', '--watch'], dir, '');
    assert.strictEqual(badWatch.status, 2);
    assert.match(badWatch.stderr, /--stdin cannot be combined with --watch/);
    for (const other of ['check', 'example', 'init']) {
      const badCmd = run([other, '--stdin'], dir, '');
      assert.strictEqual(badCmd.status, 2, other);
      assert.match(badCmd.stderr, new RegExp(`flag --stdin is not supported for ${other}`));
    }

    // Async child-process pipe (chunked writes + multi-byte UTF-8 split across chunks).
    asyncChecks.push(new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, 'scan', '--stdin', '--json'], {
        cwd: dir,
        env: cleanEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { err += d; });
      child.on('error', reject);
      child.on('close', code => {
        try {
          assert.strictEqual(code, 0, err);
          assert.strictEqual(err, '');
          assert.deepStrictEqual(JSON.parse(out), {
            ok: true,
            vars: ['PIPE_FIRST', 'PIPE_SECOND'],
            locations: {
              PIPE_FIRST: [{ file: '-', line: 2 }],
              PIPE_SECOND: [{ file: '-', line: 3 }],
            },
          });
          resolve();
        } catch (assertionErr) {
          reject(assertionErr);
        }
      });
      const buf = Buffer.from('const icon = "🚀";\nconst a = process.env.PIPE_FIRST;\nconst b = process.env.PIPE_SECOND;\n', 'utf8');
      const splitAt = buf.indexOf(0xf0) + 2; // split mid-4-byte UTF-8 sequence
      child.stdin.write(buf.subarray(0, splitAt));
      child.stdin.end(buf.subarray(splitAt));
    }));

    // Large piped output (>300 KiB) under delayed stdout drain must flush completely without truncation.
    const largeCount = 15000;
    const largeCode = Array.from(
      { length: largeCount },
      (_, i) => `process.env.LARGE_PIPE_KEY_${String(i).padStart(5, '0')};`
    ).join('\n');
    for (const jsonFlag of [true, false]) {
      asyncChecks.push(new Promise((resolve, reject) => {
        const args = jsonFlag ? [CLI, 'scan', '--stdin', '--json'] : [CLI, 'scan', '--stdin'];
        const child = spawn(process.execPath, args, {
          cwd: dir,
          env: cleanEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let err = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', d => { err += d; });
        child.on('error', reject);
        child.stdin.end(largeCode, () => {
          setTimeout(() => {
            let out = '';
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', d => { out += d; });
            child.on('close', (code) => {
              try {
                assert.strictEqual(code, 0, err);
                assert.strictEqual(err, '');
                if (jsonFlag) {
                  const parsed = JSON.parse(out);
                  assert.strictEqual(parsed.ok, true);
                  assert.strictEqual(parsed.vars.length, largeCount);
                  assert.strictEqual(parsed.vars[0], 'LARGE_PIPE_KEY_00000');
                  assert.strictEqual(parsed.vars[largeCount - 1], 'LARGE_PIPE_KEY_14999');
                } else {
                  const lines = out.trimEnd().split('\n');
                  assert.strictEqual(lines.length, largeCount);
                  assert.strictEqual(lines[0], 'LARGE_PIPE_KEY_00000');
                  assert.strictEqual(lines[largeCount - 1], 'LARGE_PIPE_KEY_14999');
                }
                resolve();
              } catch (assertionErr) {
                reject(assertionErr);
              }
            });
          }, 100);
        });
      }));
    }
  }

  // Issue #418: scan and check accept a single readable supported code file.
  {
    const { runInNewContext } = require('node:vm');
    const serverSrc = [
      '// process.env.COMMENT_DECOY',
      '/* import.meta.env.BLOCK_DECOY */',
      "const literal = 'process.env.STRING_DECOY';",
      'const port = process.env.PORT;',
      "const host = process.env['DB.HOST'];",
      'const opt = process.env?.OPTIONAL_KEY;',
      'const vite = import.meta.env.VITE_URL;',
      "const { SECRET_TOKEN, RETRIES: r = '3' } = process.env;",
      'const env = process.env; const aliased = env.ALIAS_KEY;',
      'const tpl = `plain process.env.TPL_DECOY ${process.env.TPL_KEY}`;',
      'const { env: procEnv } = process; const dAlias = procEnv.DESTRUCTURED_PROC_KEY;',
      '',
    ].join('\n');
    const expectedServerVars = [
      'ALIAS_KEY', 'DB.HOST', 'DESTRUCTURED_PROC_KEY', 'OPTIONAL_KEY', 'PORT', 'RETRIES', 'SECRET_TOKEN', 'TPL_KEY', 'VITE_URL',
    ];
    const dir = mkProject({
      'src/server.js': serverSrc,
      'src/sibling.js': 'const s = process.env.SIBLING_UNDOCUMENTED;\n',
      'src/empty.js': '// process.env.ONLY_COMMENT\nconst x = 42;\n',
      'README.md': 'process.env.MD_DECOY\n',
      'notes.txt': 'process.env.TXT_DECOY\n',
      'UPPER.JS': 'process.env.UPPER_EXT\n',
      '.env.example': expectedServerVars.map(k => `${k}=\n`).join(''),
    });

    // 1. scan <file>: lists only that file's keys, ignores comments/literals and sibling files, exits 0.
    const plainScan = run(['scan', 'src/server.js'], dir);
    assert.strictEqual(plainScan.status, 0, `${plainScan.stdout}${plainScan.stderr}`);
    assert.strictEqual(plainScan.stderr, '');
    assert.strictEqual(plainScan.stdout, expectedServerVars.join('\n') + '\n');

    // Directory scan on the same project still includes sibling.js.
    const fullDirScan = run(['scan', dir], dir);
    assert.strictEqual(fullDirScan.status, 0);
    assert.ok(fullDirScan.stdout.split(/\r?\n/).includes('SIBLING_UNDOCUMENTED'));

    // 2. scan <file> --json preserves the exact given filename in locations.
    for (const given of ['src/server.js', './src/server.js', path.join(dir, 'src/server.js')]) {
      const jsonScan = run(['scan', given, '--json'], dir);
      assert.strictEqual(jsonScan.status, 0, `${given}: ${jsonScan.stdout}${jsonScan.stderr}`);
      assert.strictEqual(jsonScan.stderr, '');
      const parsed = JSON.parse(jsonScan.stdout);
      assert.strictEqual(parsed.ok, true);
      assert.deepStrictEqual(parsed.vars, expectedServerVars);
      assert.ok(!('unused' in parsed), 'implicit .env.example should not add unused noise to single-file scan');
      assert.deepStrictEqual(parsed.locations.PORT, [{ file: given, line: 4 }]);
      assert.deepStrictEqual(parsed.locations['DB.HOST'], [{ file: given, line: 5 }]);
      assert.deepStrictEqual(parsed.locations.TPL_KEY, [{ file: given, line: 10 }]);
    }

    // Explicit --file compares the single file's reads against the template.
    fs.writeFileSync(path.join(dir, '.env.with-extra'), expectedServerVars.map(k => `${k}=\n`).join('') + 'EXTRA_TEMPLATE_KEY=\n');
    const scanWithFile = run(['scan', 'src/server.js', '--file', '.env.with-extra', '--json'], dir);
    assert.strictEqual(scanWithFile.status, 0, `${scanWithFile.stdout}${scanWithFile.stderr}`);
    assert.deepStrictEqual(JSON.parse(scanWithFile.stdout).unused, ['EXTRA_TEMPLATE_KEY']);

    // Empty / comment-only code file reports no usage and exits 0.
    const emptyPlain = run(['scan', 'src/empty.js'], dir);
    assert.strictEqual(emptyPlain.status, 0);
    assert.strictEqual(emptyPlain.stdout, '');
    assert.strictEqual(emptyPlain.stderr, 'No process.env usage found.\n');
    const emptyJson = run(['scan', 'src/empty.js', '--json'], dir);
    assert.strictEqual(emptyJson.status, 0);
    assert.deepStrictEqual(JSON.parse(emptyJson.stdout), { ok: true, vars: [], locations: {} });

    // 3. check <file>: checks only that file against .env.example (no sibling scan).
    const dirCheck = run(['check', dir], dir);
    assert.strictEqual(dirCheck.status, 1, 'directory check must fail on sibling undocumented key');
    assert.match(dirCheck.stdout, /MISSING in \.env\.example: SIBLING_UNDOCUMENTED/);

    const fileCheck = run(['check', 'src/server.js'], dir);
    assert.strictEqual(fileCheck.status, 0, `${fileCheck.stdout}${fileCheck.stderr}`);
    assert.match(fileCheck.stdout, /all clean/);

    const fileCheckJson = run(['check', 'src/server.js', '--json'], dir);
    assert.strictEqual(fileCheckJson.status, 0);
    assert.deepStrictEqual(JSON.parse(fileCheckJson.stdout), {
      ok: true, missing: [], extra: [], unused: [], invalid: [], secrets: [], envExtra: [], envMissing: [],
    });

    // Undocumented key in the checked single file still fails check with exit 1.
    const badFileCheck = run(['check', 'src/sibling.js'], dir);
    assert.strictEqual(badFileCheck.status, 1);
    assert.match(badFileCheck.stdout, /MISSING in \.env\.example: SIBLING_UNDOCUMENTED/);

    // check <file> works with --schema, --values, --json-schema, subprojects, and outside-cwd paths.
    const schemaDir = mkProject({
      'sub/src/entry.ts': 'export const p = process.env.PORT;\n',
      'sub/.env.example': 'PORT=3000\n',
      'sub/.env': 'PORT=3000\n',
      'sub/.env.bad': 'PORT=not-a-port\n',
      'sub/env.schema.js': "module.exports = { PORT: { type: 'port', required: true } };\n",
      'schema-only/src/entry.js': 'const p = process.env.PORT;\n',
      'schema-only/env.schema.js': "module.exports = { PORT: { type: 'port', required: true } };\n",
    });
    const subOk = run(['check', 'sub/src/entry.ts', '--schema', 'env.schema.js'], schemaDir);
    assert.strictEqual(subOk.status, 0, `${subOk.stdout}${subOk.stderr}`);
    const subBad = run(['check', 'sub/src/entry.ts', '--schema', 'env.schema.js', '--values', '.env.bad'], schemaDir);
    assert.strictEqual(subBad.status, 1);
    assert.match(subBad.stdout, /INVALID in \.env\.bad: PORT/);

    const outsideCwd = mkProject({});
    const absEntry = path.join(schemaDir, 'sub', 'src', 'entry.ts');
    const fromOutside = run(['check', absEntry, '--schema', 'env.schema.js'], outsideCwd);
    assert.strictEqual(fromOutside.status, 0, `${fromOutside.stdout}${fromOutside.stderr}`);

    const jsonSchemaFromFile = run(['check', 'schema-only/src/entry.js', '--schema', 'env.schema.js', '--json-schema'], schemaDir);
    assert.strictEqual(jsonSchemaFromFile.status, 0, `${jsonSchemaFromFile.stdout}${jsonSchemaFromFile.stderr}`);
    assert.strictEqual(JSON.parse(jsonSchemaFromFile.stdout).$schema, 'https://json-schema.org/draft/2020-12/schema');

    const jsonSchemaMissingFlag = run(['check', 'src/server.js', '--json-schema'], dir);
    assert.strictEqual(jsonSchemaMissingFlag.status, 2);
    assert.match(jsonSchemaMissingFlag.stderr, /--json-schema needs --schema/);

    const subAbsSchema = run(['check', 'sub/src/entry.ts', '--schema', path.join(schemaDir, 'sub', 'env.schema.js')], schemaDir);
    assert.strictEqual(subAbsSchema.status, 0, `${subAbsSchema.stdout}${subAbsSchema.stderr}`);

    // Missing .env.example stops at cwd rather than climbing into a parent folder.
    const nestedNoExample = path.join(schemaDir, 'sub', 'nested-pkg');
    fs.mkdirSync(path.join(nestedNoExample, 'src'), { recursive: true });
    fs.writeFileSync(path.join(nestedNoExample, 'src', 'app.js'), 'const p = process.env.PORT;\n');
    const stoppedAtCwd = run(['check', 'src/app.js'], nestedNoExample);
    assert.strictEqual(stoppedAtCwd.status, 2);
    assert.match(stoppedAtCwd.stderr, /\.env\.example not found/);

    const outsideNoExample = mkProject({ 'src/app.js': 'const p = process.env.PORT;\n' });
    const missingFromOutside = run(['check', path.join(outsideNoExample, 'src', 'app.js')], outsideCwd);
    assert.strictEqual(missingFromOutside.status, 2);
    assert.match(missingFromOutside.stderr, /\.env\.example not found/);

    // package.json "env-saaf" defaults apply to explicit code-file inputs, with explicit CLI precedence.
    const fileOnlyContractDir = mkProject({
      'src/server.js': 'const p = process.env.PORT;\n',
      '.env.contract': 'PORT=3000\n',
      'package.json': '{"name":"file-only-contract","env-saaf":{"file":".env.contract"}}\n',
    });
    const fileOnlyDirOk = run(['check', '.'], fileOnlyContractDir);
    assert.strictEqual(fileOnlyDirOk.status, 0, `${fileOnlyDirOk.stdout}${fileOnlyDirOk.stderr}`);
    const fileOnlySingleOk = run(['check', 'src/server.js'], fileOnlyContractDir);
    assert.strictEqual(fileOnlySingleOk.status, 0, `${fileOnlySingleOk.stdout}${fileOnlySingleOk.stderr}`);
    assert.match(fileOnlySingleOk.stdout, /code and \.env\.contract match/);
    const contractScanJson = run(['scan', 'src/server.js', '--json'], fileOnlyContractDir);
    assert.strictEqual(contractScanJson.status, 0, `${contractScanJson.stdout}${contractScanJson.stderr}`);
    assert.deepStrictEqual(JSON.parse(contractScanJson.stdout), {
      ok: true,
      vars: ['PORT'],
      unused: [],
      locations: { PORT: [{ file: 'src/server.js', line: 1 }] },
    });

    const contractDir = mkProject({
      'src/server.js': 'const p = process.env.PORT;\n',
      'src/sibling.js': 'const s = process.env.SIBLING_ONLY;\n',
      '.env.contract': 'PORT=3000\n',
      '.env.override': 'PORT=3000\nEXTRA_OVERRIDE_KEY=\n',
      '.env': 'PORT=3000\n',
      'config/env.schema.js': "module.exports = { PORT: { type: 'port', required: true } };\n",
      'override.schema.js': "module.exports = { PORT: { type: 'string', required: true } };\n",
      'package.json': JSON.stringify({
        name: 'contract-proj',
        'env-saaf': { file: '.env.contract', schema: 'config/env.schema.js', dir: 'missing-default-dir' },
      }) + '\n',
    });
    const contractDirFail = run(['check', '.'], contractDir);
    assert.strictEqual(contractDirFail.status, 1);
    assert.match(contractDirFail.stdout, /MISSING in \.env\.contract: SIBLING_ONLY/);

    const contractFileOk = run(['check', 'src/server.js'], contractDir);
    assert.strictEqual(contractFileOk.status, 0, `${contractFileOk.stdout}${contractFileOk.stderr}`);
    assert.match(contractFileOk.stdout, /code and \.env\.contract match/);

    // A package with both env-saaf.file and env-saaf.schema defaults still runs scan on a code file
    // (ignoring check-only config.schema while applying config.file), whereas explicit CLI --schema still exits 2.
    const contractBothScanJson = run(['scan', 'src/server.js', '--json'], contractDir);
    assert.strictEqual(contractBothScanJson.status, 0, `${contractBothScanJson.stdout}${contractBothScanJson.stderr}`);
    assert.deepStrictEqual(JSON.parse(contractBothScanJson.stdout), {
      ok: true,
      vars: ['PORT'],
      unused: [],
      locations: { PORT: [{ file: 'src/server.js', line: 1 }] },
    });
    const contractDirScanJson = run(['scan', '.', '--json'], contractDir);
    assert.strictEqual(contractDirScanJson.status, 0, `${contractDirScanJson.stdout}${contractDirScanJson.stderr}`);

    for (const explicitSchemaArgs of [
      ['scan', 'src/server.js', '--schema', 'config/env.schema.js'],
      ['scan', 'src/server.js', '--schema=config/env.schema.js'],
    ]) {
      const explicitScanSchema = run(explicitSchemaArgs, contractDir);
      assert.strictEqual(explicitScanSchema.status, 2);
      assert.match(explicitScanSchema.stderr, /flag --schema is not supported for scan/);
    }

    const contractExampleOk = run(['example', contractDir], contractDir);
    assert.strictEqual(contractExampleOk.status, 0, `${contractExampleOk.stdout}${contractExampleOk.stderr}`);
    assert.match(contractExampleOk.stdout, /PORT=3000/);
    const explicitExampleFile = run(['example', contractDir, '--file', '.env.contract'], contractDir);
    assert.strictEqual(explicitExampleFile.status, 2);
    assert.match(explicitExampleFile.stderr, /flag --file is not supported for example/);

    const contractCliOverrideFile = run(['check', 'src/server.js', '--file', '.env.override'], contractDir);
    assert.strictEqual(contractCliOverrideFile.status, 1);
    assert.match(contractCliOverrideFile.stdout, /NOT IN SCHEMA: EXTRA_OVERRIDE_KEY/);

    fs.writeFileSync(path.join(contractDir, '.env'), 'PORT=not-a-port\n');
    const contractValuesSchemaCatch = run(['check', 'src/server.js', '--values', '.env'], contractDir);
    assert.strictEqual(contractValuesSchemaCatch.status, 1);
    assert.match(contractValuesSchemaCatch.stdout, /INVALID in \.env: PORT/);

    fs.writeFileSync(path.join(contractDir, '.env.contract'), 'PORT=not-a-port\n');
    const contractSchemaCatch = run(['check', 'src/server.js'], contractDir);
    assert.strictEqual(contractSchemaCatch.status, 1);
    assert.match(contractSchemaCatch.stdout, /INVALID: PORT/);

    const contractCliOverrideSchema = run(['check', 'src/server.js', '--schema', 'override.schema.js'], contractDir);
    assert.strictEqual(contractCliOverrideSchema.status, 0, `${contractCliOverrideSchema.stdout}${contractCliOverrideSchema.stderr}`);

    // Configured package.json file/schema paths resolve relative to the package that defined them,
    // never selecting same-named nested files inside a subdirectory.
    const nestedDecoyDir = mkProject({
      'package.json': '{"name":"nested-decoy","env-saaf":{"file":".env.contract","schema":"env.schema.js"}}\n',
      '.env.contract': 'ROOT_CONTRACT_KEY=3000\n',
      '.env': 'ROOT_CONTRACT_KEY=3000\n',
      'env.schema.js': "module.exports = { ROOT_CONTRACT_KEY: { type: 'port', required: true } };\n",
      'sub/.env.contract': 'NESTED_SUB_DECOY_KEY=9999\n',
      'sub/.env': 'NESTED_SUB_DECOY_KEY=9999\n',
      'sub/env.schema.js': "module.exports = { NESTED_SUB_DECOY_KEY: { type: 'port', required: true } };\n",
      'sub/app.js': 'const k = process.env.ROOT_CONTRACT_KEY;\n',
    });
    const nestedDirModeOk = run(['check', '.'], nestedDecoyDir);
    assert.strictEqual(nestedDirModeOk.status, 0, `${nestedDirModeOk.stdout}${nestedDirModeOk.stderr}`);
    const nestedCheckOk = run(['check', 'sub/app.js'], nestedDecoyDir);
    assert.strictEqual(nestedCheckOk.status, 0, `${nestedCheckOk.stdout}${nestedCheckOk.stderr}`);
    assert.match(nestedCheckOk.stdout, /code and \.env\.contract match/);
    const nestedCheckOutsideOk = run(['check', path.join(nestedDecoyDir, 'sub', 'app.js')], outsideCwd);
    assert.strictEqual(nestedCheckOutsideOk.status, 0, `${nestedCheckOutsideOk.stdout}${nestedCheckOutsideOk.stderr}`);
    const nestedScanJson = run(['scan', 'sub/app.js', '--json'], nestedDecoyDir);
    assert.strictEqual(nestedScanJson.status, 0, `${nestedScanJson.stdout}${nestedScanJson.stderr}`);
    assert.deepStrictEqual(JSON.parse(nestedScanJson.stdout), {
      ok: true,
      vars: ['ROOT_CONTRACT_KEY'],
      unused: [],
      locations: { ROOT_CONTRACT_KEY: [{ file: 'sub/app.js', line: 1 }] },
    });
    const nestedJsonSchema = run(['check', 'sub/app.js', '--json-schema'], nestedDecoyDir);
    assert.strictEqual(nestedJsonSchema.status, 0, `${nestedJsonSchema.stdout}${nestedJsonSchema.stderr}`);
    assert.deepStrictEqual(Object.keys(JSON.parse(nestedJsonSchema.stdout).properties), ['ROOT_CONTRACT_KEY']);

    // Schema-only package config also anchors to the defining package root rather than a nested subdir decoy.
    const schemaOnlyPkgDir = mkProject({
      'package.json': '{"name":"schema-only-pkg","env-saaf":{"schema":"env.schema.js"}}\n',
      '.env.example': 'ROOT_SCHEMA_KEY=3000\n',
      '.env': 'ROOT_SCHEMA_KEY=3000\n',
      'env.schema.js': "module.exports = { ROOT_SCHEMA_KEY: { type: 'port', required: true } };\n",
      'sub/.env.example': 'NESTED_SCHEMA_DECOY=9999\n',
      'sub/env.schema.js': "module.exports = { NESTED_SCHEMA_DECOY: { type: 'port', required: true } };\n",
      'sub/app.js': 'const k = process.env.ROOT_SCHEMA_KEY;\n',
    });
    const schemaOnlyPkgOk = run(['check', 'sub/app.js'], schemaOnlyPkgDir);
    assert.strictEqual(schemaOnlyPkgOk.status, 0, `${schemaOnlyPkgOk.stdout}${schemaOnlyPkgOk.stderr}`);

    // An empty env-saaf config object without file/schema defaults still lets an unconfigured subproject resolve its .env.example.
    const emptyCfgSubDir = mkProject({
      'package.json': '{"name":"empty-cfg","env-saaf":{}}\n',
      'sub/.env.example': 'SUB_LOCAL_KEY=1\n',
      'sub/app.js': 'const k = process.env.SUB_LOCAL_KEY;\n',
    });
    const emptyCfgSubOk = run(['check', 'sub/app.js'], emptyCfgSubDir);
    assert.strictEqual(emptyCfgSubOk.status, 0, `${emptyCfgSubOk.stdout}${emptyCfgSubOk.stderr}`);

    // Subpackage package.json bounds context lookup and does not leak to a parent monorepo root.
    const monoDir = mkProject({
      'package.json': '{"name":"mono-root","env-saaf":{"file":".env.root"}}\n',
      '.env.root': 'PORT=3000\n',
      '.env.example': 'PORT=3000\n',
      'packages/web/package.json': '{"name":"web-pkg","env-saaf":{"file":".env.web"}}\n',
      'packages/web/src/app.js': 'const p = process.env.PORT;\n',
      'packages/plain/package.json': '{"name":"plain-pkg"}\n',
      'packages/plain/src/app.js': 'const p = process.env.PORT;\n',
    });
    const monoMissingWeb = run(['check', 'packages/web/src/app.js'], monoDir);
    assert.strictEqual(monoMissingWeb.status, 2);
    assert.match(monoMissingWeb.stderr, /\.env\.web not found in .*packages[\\/]web/);
    const monoMissingPlain = run(['check', 'packages/plain/src/app.js'], monoDir);
    assert.strictEqual(monoMissingPlain.status, 2);
    assert.match(monoMissingPlain.stderr, /\.env\.example not found in .*packages[\\/]plain/);

    // Config lookup stops at cwd rather than climbing into an unrelated parent package.json.
    const parentTrapRoot = mkProject({
      'package.json': '{"name":"parent-trap","env-saaf":{"file":".env.parent-trap"}}\n',
      'child/.env.example': 'PORT=3000\n',
      'child/src/app.js': 'const p = process.env.PORT;\n',
    });
    const childStoppedAtCwd = run(['check', 'src/app.js'], path.join(parentTrapRoot, 'child'));
    assert.strictEqual(childStoppedAtCwd.status, 0, `${childStoppedAtCwd.stdout}${childStoppedAtCwd.stderr}`);

    // Malformed package.json in the selected file's project still exits 2.
    const brokenPkgFileDir = mkProject({
      'package.json': '{"name":\n',
      '.env.example': 'PORT=3000\n',
      'src/app.js': 'const p = process.env.PORT;\n',
    });
    const brokenPkgFileRes = run(['check', 'src/app.js'], brokenPkgFileDir);
    assert.strictEqual(brokenPkgFileRes.status, 2);
    assert.match(brokenPkgFileRes.stderr, /cannot read project config/);

    // package.json "env-saaf.dir" pointing to a single file preserves the configured path in locations
    // and resolves configured defaults relative to the package root rather than src/.
    const cfgFileDir = mkProject({
      'src/only.js': 'const c = process.env.CFG_KEY;\n',
      'src/.env.contract': 'NESTED_CFG_DECOY=bad\n',
      '.env.contract': 'CFG_KEY=ok\n',
      'package.json': '{"name":"cfg-file","env-saaf":{"dir":"src/only.js","file":".env.contract"}}\n',
    });
    const cfgScan = run(['scan', '--json'], cfgFileDir);
    assert.strictEqual(cfgScan.status, 0, `${cfgScan.stdout}${cfgScan.stderr}`);
    assert.deepStrictEqual(JSON.parse(cfgScan.stdout), {
      ok: true,
      vars: ['CFG_KEY'],
      unused: [],
      locations: { CFG_KEY: [{ file: 'src/only.js', line: 1 }] },
    });
    const cfgCheck = run(['check'], cfgFileDir);
    assert.strictEqual(cfgCheck.status, 0, `${cfgCheck.stdout}${cfgCheck.stderr}`);
    const cfgDirOnly = mkProject({
      'src/only.js': 'const c = process.env.CFG_KEY;\n',
      'package.json': '{"name":"cfg-dir-only","env-saaf":{"dir":"src/only.js"}}\n',
    });
    const cfgExample = run(['example'], cfgDirOnly);
    assert.strictEqual(cfgExample.status, 2);
    assert.match(cfgExample.stderr, /is not a directory/);

    // Symlinked parent segment (src/jump/../app.js -> ../other/sub) stats and reads the same real target
    // while preserving the supplied location string and ignoring lexical decoy src/app.js.
    const symProj = mkProject({
      'src/app.js': 'const bad = process.env.LEXICAL_DECOY_KEY;\n',
      'src/.env.example': 'LEXICAL_DECOY_KEY=\n',
      'other/sub/.keep': '',
      'other/app.js': 'const good = process.env.REAL_SYMLINK_TARGET_KEY;\n',
      'other/.env.contract': 'REAL_SYMLINK_TARGET_KEY=\n',
      'other/package.json': '{"name":"other-pkg","env-saaf":{"file":".env.contract"}}\n',
    });
    let createdDirSymlink = false;
    try {
      fs.symlinkSync(path.join('..', 'other', 'sub'), path.join(symProj, 'src', 'jump'), 'dir');
      createdDirSymlink = true;
    } catch {
      createdDirSymlink = false;
    }
    if (createdDirSymlink) {
      const symScan = run(['scan', 'src/jump/../app.js', '--json'], symProj);
      assert.strictEqual(symScan.status, 0, `${symScan.stdout}${symScan.stderr}`);
      assert.deepStrictEqual(JSON.parse(symScan.stdout), {
        ok: true,
        vars: ['REAL_SYMLINK_TARGET_KEY'],
        unused: [],
        locations: { REAL_SYMLINK_TARGET_KEY: [{ file: 'src/jump/../app.js', line: 1 }] },
      });
      const symCheck = run(['check', 'src/jump/../app.js'], symProj);
      assert.strictEqual(symCheck.status, 0, `${symCheck.stdout}${symCheck.stderr}`);
    }

    // 4. Every supported code extension is accepted by both scan and check.
    const extFiles = {};
    const extNames = ['js', 'cjs', 'mjs', 'ts', 'mts', 'cts', 'tsx', 'jsx', 'vue', 'svelte', 'astro'];
    for (const ext of extNames) {
      extFiles[`f.${ext}`] = ext === 'vue' || ext === 'svelte'
        ? `<script>const v = process.env.EXT_${ext.toUpperCase()};</script>\n`
        : ext === 'astro'
          ? `---\nconst v = process.env.EXT_ASTRO;\n---\n`
          : `const v = process.env.EXT_${ext.toUpperCase()};\n`;
    }
    const extDir = mkProject(extFiles);
    for (const ext of extNames) {
      const key = `EXT_${ext.toUpperCase()}`;
      fs.writeFileSync(path.join(extDir, '.env.example'), `${key}=\n`);
      const s = run(['scan', `f.${ext}`], extDir);
      assert.strictEqual(s.status, 0, `scan f.${ext}: ${s.stderr}`);
      assert.strictEqual(s.stdout.trim(), key);
      const c = run(['check', `f.${ext}`], extDir);
      assert.strictEqual(c.status, 0, `check f.${ext}: ${c.stdout}${c.stderr}`);
    }

    // 5. Absent paths, unsupported extensions, unreadable files, --stdin + file, and other commands exit 2.
    for (const cmdName of ['scan', 'check']) {
      for (const absent of ['src/missing.js', 'nope.ts']) {
        const mText = run([cmdName, absent], dir);
        assert.strictEqual(mText.status, 2, `${cmdName} ${absent}`);
        assert.strictEqual(mText.stderr.trim(), `env-saaf: ${absent} does not exist`);
        const mJson = run([cmdName, absent, '--json'], dir);
        assert.strictEqual(mJson.status, 2);
        assert.deepStrictEqual(JSON.parse(mJson.stdout), {
          ok: false,
          error: `env-saaf: ${absent} does not exist`,
        });
      }
      for (const unsupported of ['README.md', 'notes.txt', '.env.example', 'UPPER.JS']) {
        const uText = run([cmdName, unsupported], dir);
        assert.strictEqual(uText.status, 2, `${cmdName} ${unsupported}`);
        assert.strictEqual(uText.stderr.trim(), `env-saaf: ${unsupported} is not a directory`);
        const uJson = run([cmdName, unsupported, '--json'], dir);
        assert.strictEqual(uJson.status, 2);
        assert.deepStrictEqual(JSON.parse(uJson.stdout), {
          ok: false,
          error: `env-saaf: ${unsupported} is not a directory`,
        });
      }
    }

    for (const dirOnlyCmd of [['example', 'src/server.js'], ['init', 'src/server.js'], ['print', 'src/server.js', '--schema', 'env.schema.js']]) {
      const res = run(dirOnlyCmd, dir);
      assert.strictEqual(res.status, 2, dirOnlyCmd.join(' '));
      assert.match(res.stderr, /src\/server\.js is not a directory/);
    }

    for (const stdinConflict of [['scan', '--stdin', 'src/server.js'], ['scan', 'src/server.js', '--stdin']]) {
      const res = run(stdinConflict, dir, 'process.env.PORT;\n');
      assert.strictEqual(res.status, 2);
      assert.match(res.stderr, /--stdin cannot be combined with a directory argument/);
    }

    if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
      const sealed = path.join(dir, 'src', 'sealed.js');
      fs.writeFileSync(sealed, 'process.env.SEALED;\n');
      fs.chmodSync(sealed, 0o000);
      try {
        for (const cmdName of ['scan', 'check']) {
          const r = run([cmdName, 'src/sealed.js'], dir);
          assert.strictEqual(r.status, 2);
          assert.strictEqual(r.stderr.trim(), 'env-saaf: src/sealed.js is not a directory');
        }
      } finally {
        fs.chmodSync(sealed, 0o600);
      }
    }

    // Deterministic cross-platform check for unreadable code files, non-regular entries, stat failures,
    // symlink parent canonicalization, and non-ENOENT read error propagation.
    const cliSource = fs.readFileSync(CLI, 'utf8');
    const stubRealpath = Object.assign((p) => path.resolve(dir, p), {
      native: (p) => path.resolve(dir, p),
    });
    for (const [scenario, fsStub, expectedErr] of [
      ['unreadable-js', {
        existsSync: (p) => p === 'src/locked.js',
        realpathSync: stubRealpath,
        statSync: () => ({ isDirectory: () => false, isFile: () => true }),
        openSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); },
        constants: fs.constants,
      }, 'env-saaf: src/locked.js is not a directory'],
      ['non-regular-js', {
        existsSync: (p) => p === 'src/fifo.js',
        realpathSync: stubRealpath,
        statSync: () => ({ isDirectory: () => false, isFile: () => false }),
        openSync: () => 3,
        closeSync: () => {},
        constants: fs.constants,
      }, 'env-saaf: src/fifo.js is not a directory'],
      ['stat-throws', {
        existsSync: (p) => p === 'src/vanished.js',
        realpathSync: stubRealpath,
        statSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
        constants: fs.constants,
      }, 'env-saaf: src/vanished.js does not exist'],
    ]) {
      const targetArg = scenario === 'unreadable-js' ? 'src/locked.js'
        : scenario === 'non-regular-js' ? 'src/fifo.js' : 'src/vanished.js';
      for (const cmdName of ['scan', 'check']) {
        let exitCode = null;
        const errors = [];
        const req = (id) => (id === 'node:fs' ? fsStub : id === './index' ? require('./index') : require(id));
        req.resolve = require.resolve;
        req.cache = {};
        try {
          runInNewContext(cliSource, {
            require: req,
            console: { log: () => {}, error: (m) => errors.push(m) },
            Buffer,
            URL,
            setTimeout,
            clearTimeout,
            process: {
              argv: ['node', 'cli.js', cmdName, targetArg],
              cwd: () => dir,
              platform: process.platform,
              exit: (code) => { exitCode = code; throw new Error('__EXIT__'); },
            },
          });
        } catch (e) {
          if (e.message !== '__EXIT__') throw e;
        }
        assert.strictEqual(exitCode, 2, `${scenario} (${cmdName})`);
        assert.deepStrictEqual(errors, [expectedErr], `${scenario} (${cmdName})`);
      }
    }

    // Cross-platform symlink-parent check (verifies realpathSync.native parent resolution even without Windows symlink privilege).
    {
      const realSymProj = fs.realpathSync.native(symProj);
      const realOtherFile = path.join(realSymProj, 'other', 'app.js');
      const lexicalWrongFile = path.join(realSymProj, 'src', 'app.js');
      const logs = [];
      let exitCode = null;
      const symStub = {
        ...fs,
        realpathSync: Object.assign(
          () => { throw new Error('must use realpathSync.native so symlinked parent .. is not collapsed lexically'); },
          {
            native: (p) => (p === 'src/jump/..' || p === 'src\\jump\\..' ? path.join(realSymProj, 'other') : fs.realpathSync.native(p)),
          },
        ),
        readFileSync: (p, enc) => {
          if (path.resolve(p) === path.resolve(lexicalWrongFile)) {
            throw new Error('must not read lexical decoy src/app.js');
          }
          return fs.readFileSync(p, enc);
        },
      };
      const req = (id) => (id === 'node:fs' ? symStub : id === './index' ? require('./index') : require(id));
      req.resolve = require.resolve;
      req.cache = {};
      try {
        runInNewContext(cliSource, {
          require: req,
          console: { log: (m) => logs.push(m), error: () => {} },
          Buffer,
          URL,
          setTimeout,
          clearTimeout,
          process: {
            argv: ['node', 'cli.js', 'scan', 'src/jump/../app.js', '--json'],
            cwd: () => symProj,
            platform: process.platform,
            exit: (code) => { exitCode = code; throw new Error('__EXIT__'); },
          },
        });
      } catch (e) {
        if (e.message !== '__EXIT__') throw e;
      }
      assert.strictEqual(exitCode, 0);
      const symParsed = JSON.parse(logs[0]);
      assert.strictEqual(symParsed.ok, true);
      assert.deepStrictEqual(symParsed.vars, ['REAL_SYMLINK_TARGET_KEY']);
      assert.deepStrictEqual(symParsed.unused, []);
      assert.deepStrictEqual(symParsed.locations, {
        REAL_SYMLINK_TARGET_KEY: [{ file: 'src/jump/../app.js', line: 1 }],
      });
      assert.ok(fs.existsSync(realOtherFile));
    }

    // Static read race and non-ENOENT watch read failures still propagate rather than being swallowed.
    {
      let caughtErr = null;
      const watchedPaths = [];
      const makeFailStub = (errCode) => ({
        ...fs,
        existsSync: (p) => p === path.join(dir, '.env.example'),
        realpathSync: stubRealpath,
        statSync: () => ({ isDirectory: () => false, isFile: () => true }),
        openSync: () => 3,
        closeSync: () => {},
        watch: (p) => { watchedPaths.push(p); return { close: () => {} }; },
        readdirSync: () => [],
        readFileSync: () => { throw Object.assign(new Error(`read failed: ${errCode}`), { code: errCode }); },
      });
      const reqStatic = (id) => (id === 'node:fs' ? makeFailStub('ENOENT') : id === './index' ? require('./index') : require(id));
      reqStatic.resolve = require.resolve;
      reqStatic.cache = {};
      try {
        runInNewContext(cliSource, {
          require: reqStatic,
          console: { log: () => {}, error: () => {} },
          Buffer,
          URL,
          setTimeout: () => 1,
          clearTimeout: () => {},
          process: {
            argv: ['node', 'cli.js', 'scan', 'src/server.js'],
            cwd: () => dir,
            platform: process.platform,
            on: () => {},
            exit: (code) => { throw new Error(`unexpected process.exit(${code})`); },
          },
        });
      } catch (e) {
        caughtErr = e;
      }
      assert.ok(caughtErr && caughtErr.code === 'ENOENT', `expected static ENOENT to propagate, got ${caughtErr}`);

      asyncChecks.push((async () => {
        let watchExit = null;
        const watchErrors = [];
        const reqWatch = (id) => (id === 'node:fs' ? makeFailStub('EIO') : id === './index' ? require('./index') : require(id));
        reqWatch.resolve = require.resolve;
        reqWatch.cache = {};
        runInNewContext(cliSource, {
          require: reqWatch,
          console: { log: () => {}, error: (m) => watchErrors.push(m) },
          Buffer,
          URL,
          setTimeout: () => 1,
          clearTimeout: () => {},
          process: {
            argv: ['node', 'cli.js', 'scan', 'src/server.js', '--watch'],
            cwd: () => dir,
            platform: process.platform,
            on: () => {},
            exit: (code) => { watchExit = code; },
          },
        });
        await Promise.resolve();
        await Promise.resolve();
        assert.strictEqual(watchExit, 1);
        assert.ok(watchErrors.some((e) => e && e.code === 'EIO'));
        assert.ok(watchedPaths.includes(path.join(dir, 'src')));
      })());
    }

    // 6. --watch survives temporary removal of a selected single file, reports exit 2 per run,
    // and recovers when restored, while static missing-file --watch still exits 2 immediately.
    for (const cmdName of ['scan', 'check']) {
      const staticWatchMissing = run([cmdName, 'src/missing-watch.js', '--watch'], dir);
      assert.strictEqual(staticWatchMissing.status, 2);
      assert.strictEqual(staticWatchMissing.stderr.trim(), 'env-saaf: src/missing-watch.js does not exist');
    }

    {
      const { spawn } = require('node:child_process');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const stopWatcher = (child) => new Promise((resolve, reject) => {
        child.once('exit', (code, signal) => {
          try {
            if (process.platform === 'win32') assert.strictEqual(signal, 'SIGINT');
            else assert.strictEqual(code, 0);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
        child.kill('SIGINT');
      });

      asyncChecks.push((async () => {
        const wDir = mkProject({
          'src/target.js': 'const p = process.env.PORT;\n',
          'src/sibling.js': 'const s = process.env.SIBLING_NEVER_WATCHED;\n',
          '.env.example': 'PORT=3000\n',
        });
        const targetPath = path.join(wDir, 'src', 'target.js');
        const child = spawn(process.execPath, [CLI, 'check', 'src/target.js', '--watch'], {
          cwd: wDir,
          env: cleanEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let exited = null;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('exit', (code, signal) => { exited = { code, signal }; });
        const waitFor = async (pred, what, timeoutMs = 8000) => {
          const start = Date.now();
          while (!pred()) {
            if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; output:\n${out}`);
            await sleep(50);
          }
        };
        const runCount = () => (out.match(/check finished, exit/g) || []).length;

        try {
          await waitFor(() => /all clean/.test(out) && /check finished, exit 0/.test(out), 'initial single-file watch pass');
          assert.strictEqual(runCount(), 1);

          fs.unlinkSync(targetPath);
          await waitFor(
            () => /env-saaf: src\/target\.js does not exist/.test(out) && /check finished, exit 2/.test(out) && runCount() >= 2,
            'missing single-file watch exit 2',
          );
          await sleep(250);
          assert.strictEqual(exited, null, 'watcher must stay alive while selected file is missing');

          const countBeforeRestore = runCount();
          fs.writeFileSync(targetPath, 'const p = process.env.PORT;\nconst u = process.env.RESTORED_DRIFT;\n');
          await waitFor(
            () => /MISSING in \.env\.example: RESTORED_DRIFT/.test(out) && /check finished, exit 1/.test(out) && runCount() > countBeforeRestore,
            'restored single-file watch drift exit 1',
          );
          assert.doesNotMatch(out, /SIBLING_NEVER_WATCHED/);

          const countBeforeClean = runCount();
          fs.writeFileSync(targetPath, 'const p = process.env.PORT;\n');
          await waitFor(
            () => runCount() > countBeforeClean && /check finished, exit 0\s*$/.test(out),
            'restored single-file watch clean exit 0',
          );
        } finally {
          if (exited === null) await stopWatcher(child);
        }
      })());

      asyncChecks.push((async () => {
        const wDir = mkProject({
          'src/scan-target.js': 'const p = process.env.PORT;\n',
        });
        const targetPath = path.join(wDir, 'src', 'scan-target.js');
        const child = spawn(process.execPath, [CLI, 'scan', 'src/scan-target.js', '--json', '--watch'], {
          cwd: wDir,
          env: cleanEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let exited = null;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('exit', (code, signal) => { exited = { code, signal }; });
        const waitFor = async (pred, what, timeoutMs = 8000) => {
          const start = Date.now();
          while (!pred()) {
            if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; stdout:\n${stdout}\nstderr:\n${stderr}`);
            await sleep(50);
          }
        };
        const runCount = () => (stderr.match(/scan finished, exit/g) || []).length;

        try {
          await waitFor(() => /scan finished, exit 0/.test(stderr), 'initial json scan watch pass');
          fs.unlinkSync(targetPath);
          await waitFor(
            () => stdout.includes('"error":"env-saaf: src/scan-target.js does not exist"') && /scan finished, exit 2/.test(stderr),
            'missing json scan watch exit 2',
          );
          await sleep(250);
          assert.strictEqual(exited, null, 'json scan watcher must stay alive while selected file is missing');

          const countBeforeRestore = runCount();
          fs.writeFileSync(targetPath, 'const r = process.env.RESTORED_JSON_KEY;\n');
          await waitFor(
            () => stdout.includes('"RESTORED_JSON_KEY"') && runCount() > countBeforeRestore,
            'restored json scan watch pass',
          );
          const jsonLines = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
          assert.deepStrictEqual(jsonLines[jsonLines.length - 1], {
            ok: true,
            vars: ['RESTORED_JSON_KEY'],
            locations: { RESTORED_JSON_KEY: [{ file: 'src/scan-target.js', line: 1 }] },
          });
        } finally {
          if (exited === null) await stopWatcher(child);
        }
      })());
    }
  }

  // --- issue #416: check flags secret-looking values in .env.example ----------
  {
    const { spawn } = require('node:child_process');
    const { generateExample } = require('./index');

    // Seeded generator builds synthetic credential strings dynamically at runtime.
    const makeRng = (seed) => {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6D2B79F5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), s | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    };
    const pickChars = (rand, alphabet, len) => {
      let out = '';
      for (let i = 0; i < len; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
      return out;
    };
    const rand = makeRng(416001);
    const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const HEX = '0123456789abcdef';
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

    const syntheticSecrets = {
      OPENAI_KEY: ['sk', 'proj', pickChars(rand, ALNUM, 28)].join('-'),
      ANTHROPIC_KEY: ['sk', 'ant', 'api03', pickChars(rand, ALNUM, 26)].join('-'),
      STRIPE_KEY: ['sk', 'live', pickChars(rand, ALNUM, 24)].join('_'),
      AWS_ACCESS_KEY_ID: 'AKIA' + pickChars(rand, UPPER_ALNUM, 16),
      DATABASE_URL: ['postgres://user:', 'pass', '@localhost:5432/app'].join(''),
      REDIS_URL: `redis://:${pickChars(rand, ALNUM, 14)}@cache.internal:6379/0`,
      HEX_TOKEN_40: pickChars(rand, HEX, 40),
      HEX_TOKEN_64: pickChars(rand, HEX, 64),
      GITHUB_TOKEN: ['ghp', pickChars(rand, ALNUM, 36)].join('_'),
      SLACK_TOKEN: ['xoxb', '1234567890', pickChars(rand, ALNUM, 24)].join('-'),
      JWT_TOKEN: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ1c2VyXzEyMyJ9', pickChars(rand, B64URL, 32)].join('.'),
      PEM_KEY: ['-----BEGIN RSA', 'PRIVATE KEY-----\\n', pickChars(rand, B64, 48), '\\n-----END RSA', 'PRIVATE KEY-----'].join(' '),
      HIGH_ENTROPY_B64: pickChars(rand, B64, 30) + '==',
      HIGH_ENTROPY_MIXED: pickChars(rand, ALNUM, 32),
      HIGH_ENTROPY_LOWER: Array.from({ length: 16 }, () => (
        'abcdefghjkmnpqrstuvwxyz'[Math.floor(rand() * 23)] + '23456789'[Math.floor(rand() * 8)]
      )).join(''),
      JSON_SECRET: JSON.stringify({ nested: { token: ['sk', pickChars(rand, ALNUM, 22)].join('-') } }),
      LIST_SECRET: ['placeholder', ['sk', pickChars(rand, ALNUM, 22)].join('-')].join(','),
      BEARER_SECRET: 'Bearer ' + ['sk', pickChars(rand, ALNUM, 22)].join('-'),
      URL_QUERY_SECRET: 'https://api.example.com/v1?api_key=' + ['sk', pickChars(rand, ALNUM, 22)].join('-'),
      URL_PATH_SECRET: 'https://hooks.example.com/services/' + pickChars(rand, ALNUM, 28),
    };

    const assertNoLeak = (output, map, label) => {
      for (const [k, raw] of Object.entries(map)) {
        assert.ok(!output.includes(raw), `${label}: leaked secret value for ${k}`);
        if (raw.length >= 20 && !raw.includes('://') && !raw.startsWith('{') && !raw.includes(',') && !raw.includes('PRIVATE KEY')) {
          assert.ok(!output.includes(raw.slice(-8)), `${label}: leaked secret tail for ${k}`);
        }
      }
    };

    // 1. Secret shapes in .env.example fail check (exit 1), name keys, mask values, and surface `secrets` in --json.
    const secretKeys = Object.keys(syntheticSecrets);
    const secretCode = secretKeys.map(k => `void process.env.${k};`).join('\n') + '\n';
    const secretExample = secretKeys.map(k => `${k}=${JSON.stringify(syntheticSecrets[k])}`).join('\n') + '\n';
    const badDir = mkProject({ 'src/app.js': secretCode, '.env.example': secretExample });

    const textCheck = run(['check', badDir], badDir);
    assert.strictEqual(textCheck.status, 1, `${textCheck.stdout}${textCheck.stderr}`);
    assert.strictEqual(textCheck.stderr, '');
    assertNoLeak(textCheck.stdout + textCheck.stderr, syntheticSecrets, 'text check');
    for (const k of secretKeys) {
      assert.match(
        textCheck.stdout,
        new RegExp(`^SECRET in \\.env\\.example: ${k} \\(value \\[REDACTED\\] looks like a real secret; use an empty value or placeholder\\)$`, 'm'),
        `expected SECRET line for ${k}`,
      );
    }

    const jsonCheck = run(['check', badDir, '--json'], badDir);
    assert.strictEqual(jsonCheck.status, 1);
    assert.strictEqual(jsonCheck.stderr, '');
    assertNoLeak(jsonCheck.stdout, syntheticSecrets, 'json check');
    const jsonParsed = JSON.parse(jsonCheck.stdout);
    assert.strictEqual(jsonParsed.ok, false);
    assert.deepStrictEqual(jsonParsed.secrets, secretKeys);

    // Intra-file ${VAR} expansion inside .env.example also flags derived keys without leaking values.
    const interpSecret = ['sk', 'live', pickChars(rand, ALNUM, 24)].join('_');
    const interpDir = mkProject({
      'src/app.js': 'void (process.env.RAW_PART && process.env.DERIVED_KEY);\n',
      '.env.example': `RAW_PART=${interpSecret}\nDERIVED_KEY=\${RAW_PART}\n`,
    });
    const interpRes = run(['check', interpDir, '--json'], interpDir);
    assert.strictEqual(interpRes.status, 1);
    assertNoLeak(interpRes.stdout + interpRes.stderr, { RAW_PART: interpSecret }, 'intra-file interpolation');
    assert.deepStrictEqual(JSON.parse(interpRes.stdout).secrets, ['RAW_PART', 'DERIVED_KEY']);

    // 2. Empty values, common placeholders, non-secret formats, ambient process.env, real .env secrets, and generateExample pass.
    const placeholderEntries = [
      ['EMPTY_KEY', ''],
      ['WHITESPACE_KEY', '"   "'],
      ['YOUR_KEY_HERE', 'your-key-here'],
      ['YOUR_VALUE_HERE', 'your_value_here'],
      ['YOUR_UPPER_HERE', 'YOUR_API_KEY_HERE'],
      ['ANGLE_REDACTED', '<redacted>'],
      ['BRACKET_REDACTED', '[REDACTED]'],
      ['XXX_SHORT', 'xxx'],
      ['XXX_LONG', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
      ['CHANGEME', 'changeme'],
      ['PROSE_PLACEHOLDER', 'replace-with-a-secret-at-least-32-characters-long'],
      ['GENERIC_TOKEN_NAME', 'secret_token'],
      ['PREFIXED_PLACEHOLDER', 'sk-your-key-here'],
      ['PREFIXED_UPPER_PLACEHOLDER', 'sk-YOUR_KEY_HERE'],
      ['PREFIXED_SUFFIX_HERE', 'sk-api-token-here'],
      ['PREFIXED_PAIR_REPEAT', 'sk-abababababababab'],
      ['PREFIXED_XXX', 'sk-xxxxxxxxxxxxxxxxxxxx'],
      ['DB_LOCAL', 'postgres://localhost:5432/app'],
      ['DB_USER_NO_PASS', 'postgres://user@localhost:5432/app'],
      ['DB_EMPTY_PASS', 'postgres://user:@localhost:5432/app'],
      ['DB_REDACTED_PASS', 'postgres://user:<redacted>@localhost:5432/app'],
      ['DB_CHANGEME_PASS', 'postgres://user:changeme@localhost:5432/app'],
      ['DB_PLACEHOLDER_PASS', 'postgres://user:your-password-here@localhost:5432/app'],
      ['DB_XXX_PASS', 'postgres://user:xxx@localhost:5432/app'],
      ['HTTPS_API_URL', 'https://api.staging.example.com/v1/webhooks/callback'],
      ['DURATION_MS', '500ms'],
      ['DURATION_COMPOUND', '1h30m'],
      ['DATE_ISO', '2026-01-31T12:30:00Z'],
      ['SEMVER_PRERELEASE', '1.2.3-beta.1'],
      ['IPV4_ADDR', '192.168.10.25'],
      ['IPV6_SCOPED', 'fe80::1%eth0'],
      ['EMAIL_ADDR', 'support@notifications.example.com'],
      ['HOST_NAME', 'primary-db-01.internal.example.com'],
      ['REL_FILE_PATH', './config/production.json'],
      ['ABS_FILE_PATH', '/etc/ssl/certs/ca-bundle.crt'],
      ['UUID_SAMPLE', '550e8400-e29b-41d4-a716-446655440000'],
      ['SHORT_HEX', 'deadbeefcafebabe'],
      ['ZEROS_HEX_40', '0000000000000000000000000000000000000000'],
      ['GEN_HEX_40', 'deadbeef00000000000000000000000000000000'],
      ['SEQ_HEX_40', '0123456789abcdef0123456789abcdef01234567'],
      ['LOW_DIV_HEX_40', '0123012301230123012301230123012301230123'],
      ['ALPHABET_SEQ', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'],
      ['BEARER_PLACEHOLDER', '"Bearer your-key-here"'],
      ['B64_SAMPLE', 'aGVsbG8='],
      ['B64_PADDING', 'A'.repeat(44)],
      ['SAFE_JSON', '\'{"featureFlags":{"beta":true,"maxRetries":3}}\''],
      ['SAFE_URL_LIST', 'https://a.example,https://b.example,https://c.example'],
      ['AMBIENT_REF', '${AMBIENT_ONLY_SECRET}'],
    ];
    const cleanCode = placeholderEntries.map(([k]) => `void process.env.${k};`).join('\n') + '\n';
    const cleanExample = placeholderEntries.map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
    const localRealEnv = placeholderEntries.map(([k]) => `${k}=${syntheticSecrets.OPENAI_KEY}`).join('\n') + '\n';
    const cleanDir = mkProject({
      'src/app.js': cleanCode,
      '.env.example': cleanExample,
      '.env': localRealEnv,
    });

    const cleanSpawn = spawnSync(process.execPath, [CLI, 'check', cleanDir], {
      cwd: cleanDir,
      encoding: 'utf8',
      env: { ...cleanEnv(), AMBIENT_ONLY_SECRET: syntheticSecrets.AWS_ACCESS_KEY_ID },
    });
    assert.ifError(cleanSpawn.error);
    assert.strictEqual(cleanSpawn.status, 0, `${cleanSpawn.stdout}${cleanSpawn.stderr}`);
    assert.match(cleanSpawn.stdout, /all clean/);
    assertNoLeak(cleanSpawn.stdout + cleanSpawn.stderr, syntheticSecrets, 'clean check with ambient & .env');

    const cleanJsonSpawn = spawnSync(process.execPath, [CLI, 'check', cleanDir, '--json'], {
      cwd: cleanDir,
      encoding: 'utf8',
      env: { ...cleanEnv(), AMBIENT_ONLY_SECRET: syntheticSecrets.AWS_ACCESS_KEY_ID },
    });
    assert.strictEqual(cleanJsonSpawn.status, 0);
    assert.deepStrictEqual(JSON.parse(cleanJsonSpawn.stdout).secrets, []);

    // All built-in generateExample outputs (including bounded 40-char hex, 44-char base64, and uuid/base64 arrays) pass.
    const genSchema = {
      STR: { type: 'string' },
      STR_BOUNDED: { type: 'string', minLength: 48, maxLength: 64 },
      PORT: { type: 'port' },
      URL_PLAIN: { type: 'url' },
      URL_BOUNDED: { type: 'url', minLength: 48, maxLength: 64 },
      EMAIL_BOUNDED: { type: 'email', minLength: 32, maxLength: 48 },
      HOST_BOUNDED: { type: 'host', minLength: 40, maxLength: 56 },
      SEMVER_BOUNDED: { type: 'semver', minLength: 24, maxLength: 32 },
      DURATION_DEFAULT: { type: 'duration' },
      DURATION_SUBSECOND: { type: 'duration', max: '500ms' },
      DURATION_COMPOUND: { type: 'duration', min: '1h30m', max: '2h' },
      DURATION_ARR: { type: 'array', of: 'duration' },
      UUID_ONE: { type: 'uuid' },
      UUID_ARR: { type: 'array', of: 'uuid', minItems: 4 },
      HEX_PLAIN: { type: 'hex' },
      HEX_40: { type: 'hex', length: 40, minLength: 40, maxLength: 40 },
      B64_PLAIN: { type: 'base64' },
      B64_44: { type: 'base64', minLength: 44, maxLength: 44 },
      B64_ARR: { type: 'array', of: 'base64', minItems: 5 },
      IPV6_ARR: { type: 'array', of: 'ipv6' },
      JSON_ARR: { type: 'array', of: 'json' },
      API_KEY: { type: 'string', required: true },
      SESSION_SECRET: { type: 'string', sensitive: true },
    };
    const generatedText = generateExample(genSchema);
    const genDir = mkProject({
      'src/app.js': Object.keys(genSchema).map(k => `void process.env.${k};`).join('\n') + '\n',
      '.env.example': generatedText,
    });
    const genRes = run(['check', genDir, '--json'], genDir);
    assert.strictEqual(genRes.status, 0, `${genRes.stdout}${genRes.stderr}`);
    assert.deepStrictEqual(JSON.parse(genRes.stdout).secrets, []);

    // 3. Scaffold-ahead exception (no code usage yet), --file / package.json file, single-file check, and --file + --schema redaction.
    const scaffoldSecretDir = mkProject({
      'README.md': '# new project\n',
      '.env.example': `PORT=3000\nSTRIPE_SECRET=${syntheticSecrets.STRIPE_KEY}\n`,
    });
    const scaffoldText = run(['check', scaffoldSecretDir], scaffoldSecretDir);
    assert.strictEqual(scaffoldText.status, 1);
    assert.match(scaffoldText.stdout, /SECRET in \.env\.example: STRIPE_SECRET/);
    assert.doesNotMatch(scaffoldText.stdout, /no process\.env usage found/);
    assertNoLeak(scaffoldText.stdout + scaffoldText.stderr, syntheticSecrets, 'scaffold secret text');
    const scaffoldJson = JSON.parse(run(['check', scaffoldSecretDir, '--json'], scaffoldSecretDir).stdout);
    assert.strictEqual(scaffoldJson.ok, false);
    assert.deepStrictEqual(scaffoldJson.secrets, ['STRIPE_SECRET']);
    assert.strictEqual(scaffoldJson.note, undefined);

    const sampleDir = mkProject({
      'package.json': '{"name":"sample-cfg","env-saaf":{"file":".env.sample"}}\n',
      'src/app.js': 'void (process.env.WEBHOOK_ENDPOINT && process.env.ENDPOINTS && process.env.JSON_CFG && process.env.DB_CONN && process.env.SVC_URL && process.env.LEGACY_SVC_URL && process.env.PORT);\n',
      '.env.sample': [
        `WEBHOOK_ENDPOINT=${syntheticSecrets.OPENAI_KEY}`,
        `ENDPOINTS=https://example.com,${syntheticSecrets.ANTHROPIC_KEY}`,
        `JSON_CFG=${JSON.stringify(JSON.stringify({ nested: { secret: syntheticSecrets.STRIPE_KEY } }))}`,
        `DB_CONN=${syntheticSecrets.REDIS_URL}`,
        'SVC_URL=',
        `LEGACY_SVC_URL=${syntheticSecrets.GITHUB_TOKEN}`,
        'PORT=not-a-port',
        '',
      ].join('\n'),
      'env.schema.js': [
        'module.exports = {',
        "  WEBHOOK_ENDPOINT: { type: 'url', required: true },",
        "  ENDPOINTS: { type: 'array', of: 'url', required: true },",
        "  JSON_CFG: { type: 'json', required: true, validate: (v) => 'bad leaf ' + v.nested.secret },",
        "  DB_CONN: { type: 'url', required: true, validate: (v) => 'bad pw ' + new URL(v).password },",
        "  SVC: { prefix: 'SVC_', schema: { URL: { type: 'url', required: true, aliases: ['LEGACY_SVC_URL'] } } },",
        "  PORT: { type: 'port', required: true, validate: (v, env) => env.ENDPOINTS ? 'saw ' + env.ENDPOINTS : true },",
        '};',
        '',
      ].join('\n'),
    });
    const sampleText = run(['check', 'src/app.js', '--schema', 'env.schema.js'], sampleDir);
    assert.strictEqual(sampleText.status, 1);
    assert.match(sampleText.stdout, /SECRET in \.env\.sample: WEBHOOK_ENDPOINT/);
    assert.match(sampleText.stdout, /SECRET in \.env\.sample: ENDPOINTS/);
    assert.match(sampleText.stdout, /SECRET in \.env\.sample: JSON_CFG/);
    assert.match(sampleText.stdout, /SECRET in \.env\.sample: DB_CONN/);
    assert.match(sampleText.stdout, /SECRET in \.env\.sample: LEGACY_SVC_URL/);
    assert.match(sampleText.stdout, /^INVALID: PORT: expected a port/m);
    assert.doesNotMatch(sampleText.stdout, /^INVALID: (?:WEBHOOK_ENDPOINT|ENDPOINTS|JSON_CFG|DB_CONN|SVC_URL|LEGACY_SVC_URL)/m);
    assertNoLeak(sampleText.stdout + sampleText.stderr, syntheticSecrets, 'custom --file + --schema text');

    const sampleJsonOut = run(['check', 'src/app.js', '--schema', 'env.schema.js', '--json'], sampleDir).stdout;
    assertNoLeak(sampleJsonOut, syntheticSecrets, 'custom --file + --schema json');
    const sampleJsonParsed = JSON.parse(sampleJsonOut);
    assert.deepStrictEqual(sampleJsonParsed.secrets, [
      'WEBHOOK_ENDPOINT', 'ENDPOINTS', 'JSON_CFG', 'DB_CONN', 'LEGACY_SVC_URL',
    ]);
    assert.strictEqual(sampleJsonParsed.invalid.length, 1);
    assert.match(sampleJsonParsed.invalid[0], /^PORT: expected a port/);

    // Explicit --values pointing at the template also applies the reporting boundary.
    const valuesAliasOut = run(['check', 'src/app.js', '--schema', 'env.schema.js', '--values', './.env.sample', '--json'], sampleDir).stdout;
    assertNoLeak(valuesAliasOut, syntheticSecrets, '--values template alias json');
    assert.strictEqual(JSON.parse(valuesAliasOut).invalid.length, 1);

    // Ambient-only `${VAR:?msg}` / `${VAR?msg}` placeholders never fall back to ambient secrets
    // and never skip literal or default-branch secrets elsewhere in .env.example.
    const reqPlaceholderClean = mkProject({
      'src/app.js': 'void (process.env.ENDPOINT && process.env.OPT_ENDPOINT && process.env.API_KEY);\n',
      '.env.example': [
        'ENDPOINT=https://${AMBIENT_REQ_HOST:?host required}/v1',
        'OPT_ENDPOINT=https://${AMBIENT_REQ_PLAIN?plain required}/v2',
        'API_KEY=${AMBIENT_ONLY_SECRET}',
        '',
      ].join('\n'),
    });
    const reqCleanRun = spawnSync(process.execPath, [CLI, 'check', reqPlaceholderClean, '--json'], {
      cwd: reqPlaceholderClean,
      encoding: 'utf8',
      env: {
        ...cleanEnv(),
        AMBIENT_REQ_HOST: 'api.example.com',
        AMBIENT_REQ_PLAIN: 'api2.example.com',
        AMBIENT_ONLY_SECRET: syntheticSecrets.AWS_ACCESS_KEY_ID,
      },
    });
    assert.strictEqual(reqCleanRun.status, 0, `${reqCleanRun.stdout}${reqCleanRun.stderr}`);
    assert.deepStrictEqual(JSON.parse(reqCleanRun.stdout).secrets, []);

    const reqPlaceholderMixed = mkProject({
      'src/app.js': 'void (process.env.ENDPOINT && process.env.API_KEY && process.env.LITERAL_HEX && process.env.FALLBACK_SK && process.env.SAME_LINE_DB);\n',
      '.env.example': [
        'ENDPOINT=https://${AMBIENT_REQ_HOST:?host required}/v1',
        'API_KEY=${AMBIENT_ONLY_SECRET}',
        `LITERAL_HEX=${syntheticSecrets.HEX_TOKEN_40}`,
        `FALLBACK_SK=\${UNSET_TEMPLATE_VAR:-${syntheticSecrets.OPENAI_KEY}}`,
        'SAME_LINE_DB=postgres://user:pass@${AMBIENT_REQ_HOST:?host required}:5432/app',
        '',
      ].join('\n'),
    });
    const reqMixedRun = spawnSync(process.execPath, [CLI, 'check', reqPlaceholderMixed, '--json'], {
      cwd: reqPlaceholderMixed,
      encoding: 'utf8',
      env: {
        ...cleanEnv(),
        AMBIENT_REQ_HOST: 'db.example.com',
        AMBIENT_ONLY_SECRET: syntheticSecrets.AWS_ACCESS_KEY_ID,
      },
    });
    assert.strictEqual(reqMixedRun.status, 1);
    assertNoLeak(reqMixedRun.stdout + reqMixedRun.stderr, syntheticSecrets, 'required placeholder mixed check');
    assert.deepStrictEqual(JSON.parse(reqMixedRun.stdout).secrets, [
      'LITERAL_HEX', 'FALLBACK_SK', 'SAME_LINE_DB',
    ]);

    // Missing `${VAR:?msg}` in both file and ambient env keeps existing exit-2 error semantics.
    const reqMissingBoth = run(['check', reqPlaceholderClean, '--json'], reqPlaceholderClean);
    assert.strictEqual(reqMissingBoth.status, 2);
    assert.match(JSON.parse(reqMissingBoth.stdout).error, /AMBIENT_REQ_HOST: host required/);

    // Schema warnings print once per check run, not once per validation pass.
    const warnOnceDir = mkProject({
      'src/app.js': 'void process.env.A;\n',
      '.env.example': 'A=1\n',
      '.env': 'A=1\n',
      'env.schema.js': "module.exports = { A: { type: 'string', requiredIf: { key: 'NOPE_FLAG', equals: 'x' } } };\n",
    });
    const warnOnceRun = run(['check', 'src/app.js', '--schema', 'env.schema.js'], warnOnceDir);
    assert.strictEqual(warnOnceRun.status, 0, `${warnOnceRun.stdout}${warnOnceRun.stderr}`);
    assert.strictEqual(warnOnceRun.stderr.split('undeclared key "NOPE_FLAG"').length - 1, 1);

    // 4. Watch mode (text and --json): detects a secret added to .env.example and recovers when replaced with a placeholder.
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const stopChild = (child) => new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => {
        try {
          if (process.platform === 'win32') assert.strictEqual(signal, 'SIGINT');
          else assert.strictEqual(code, 0);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      child.kill('SIGINT');
    });

    for (const useJson of [false, true]) {
      asyncChecks.push((async () => {
        const wDir = mkProject({
          'src/app.js': 'void (process.env.API_KEY && process.env.ENDPOINTS && process.env.PORT);\n',
          '.env.example': 'API_KEY=\nENDPOINTS=https://example.com\nPORT=3000\n',
          'env.schema.js': "module.exports = { API_KEY: { type: 'string' }, ENDPOINTS: { type: 'array', of: 'url', required: true }, PORT: { type: 'port', required: true } };\n",
        });
        const baseArgs = ['check', wDir, '--file', '.env.example', '--schema', 'env.schema.js', '--watch'];
        const args = useJson ? [CLI, ...baseArgs, '--json'] : [CLI, ...baseArgs];
        const child = spawn(process.execPath, args, {
          cwd: wDir,
          env: cleanEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let exited = null;
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('exit', (code, signal) => { exited = { code, signal }; });
        const waitFor = async (pred, what, timeoutMs = 8000) => {
          const start = Date.now();
          while (!pred()) {
            if (Date.now() - start > timeoutMs) {
              throw new Error(`timed out waiting for ${what}; stdout:\n${stdout}\nstderr:\n${stderr}`);
            }
            await sleep(50);
          }
        };
        const runCount = () => (stderr.match(/check finished, exit/g) || []).length;

        try {
          await waitFor(() => /check finished, exit 0/.test(stderr) && runCount() >= 1, 'initial clean watch');
          fs.writeFileSync(
            path.join(wDir, '.env.example'),
            `API_KEY=${syntheticSecrets.HEX_TOKEN_40}\nENDPOINTS=https://example.com,${syntheticSecrets.ANTHROPIC_KEY}\nPORT=not-a-port\n`,
          );
          await waitFor(
            () => /check finished, exit 1/.test(stderr) && runCount() >= 2,
            'secret added in watch mode',
          );
          assert.strictEqual(exited, null, 'watcher must stay alive after secret finding');
          assertNoLeak(stdout + stderr, syntheticSecrets, useJson ? 'watch --json' : 'watch text');
          if (useJson) {
            const lines = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
            const failing = lines[lines.length - 1];
            assert.strictEqual(failing.ok, false);
            assert.deepStrictEqual(failing.secrets, ['API_KEY', 'ENDPOINTS']);
            assert.strictEqual(failing.invalid.length, 1);
            assert.match(failing.invalid[0], /^PORT: expected a port/);
          } else {
            assert.match(stdout, /SECRET in \.env\.example: API_KEY/);
            assert.match(stdout, /SECRET in \.env\.example: ENDPOINTS/);
            assert.match(stdout, /^INVALID: PORT: expected a port/m);
            assert.doesNotMatch(stdout, /^INVALID: ENDPOINTS/m);
          }

          const beforeRecover = runCount();
          fs.writeFileSync(path.join(wDir, '.env.example'), 'API_KEY=your-key-here\nENDPOINTS=https://example.com\nPORT=3000\n');
          await waitFor(
            () => runCount() > beforeRecover && /check finished, exit 0\s*$/.test(stderr),
            'watch recovery after placeholder fix',
          );
          if (useJson) {
            const lines = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
            const recovered = lines[lines.length - 1];
            assert.strictEqual(recovered.ok, true);
            assert.deepStrictEqual(recovered.secrets, []);
            assert.deepStrictEqual(recovered.invalid, []);
          }
        } finally {
          if (exited === null) await stopChild(child);
        }
      })());
    }
  }
} catch (err) {
  cleanup();
  throw err;
}

Promise.all(asyncChecks)
  .then(() => {
    cleanup();
    console.log('test-cli.js: all CLI integration tests passed');
  })
  .catch((err) => {
    cleanup();
    console.error(err);
    process.exit(1);
  });
