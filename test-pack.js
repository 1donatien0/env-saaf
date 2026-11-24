'use strict';
// Issue #368: packaging smoke tests. `npm test` runs against the working tree,
// so a file missing from `files`, a broken `bin` path or a types entry that
// only resolves in-repo would pass here and fail for users. This packs the
// package, installs the tarball into scratch CommonJS and ESM projects and
// checks what an installed consumer actually gets.
//
// No network: the package has no runtime dependencies, so `npm install` reads
// only the local tarball. Everything lives under the OS temp dir and is removed
// afterwards.
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const EXPECTED_EXPORTS = [
  'EnvSaafError', 'diffEnv', 'generateExample', 'loadEnv', 'loadEnvAsync', 'maskSecrets',
  'maskValue', 'parseEnvFile', 'scanCode', 'scanDir', 'toJsonSchema', 'validateEnv',
  'validateSchema',
];

let tmp;
const failures = [];

function cleanup() {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
}

function run(args, cwd, extraEnv) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', ...extraEnv },
  });
  assert.ifError(result.error);
  return result;
}

function must(result, what) {
  if (result.status !== 0) {
    failures.push(`${what}\n${result.stdout || ''}${result.stderr || ''}`);
    throw new Error(`${what} failed (${result.status})`);
  }
  return result;
}

function writeProject(dir, type, files) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: `probe-${type}`, private: true, type })}\n`);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

function install(project, tarball) {
  must(run([NPM, 'install', tarball, '--no-audit', '--no-fund', '--loglevel=error', '--ignore-scripts'], project), `installing the tarball into ${path.basename(project)}`);
}

function main() {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-pack-'));

  const packed = must(run([NPM, 'pack', '--pack-destination', tmp, '--json', '--loglevel=error'], ROOT), 'npm pack');
  let info;
  try {
    const parsed = JSON.parse(packed.stdout);
    // npm 10+ prints an array; npm 12 keys the object by package name.
    info = Array.isArray(parsed) ? parsed[0] : parsed[Object.keys(parsed)[0]];
  } catch {
    throw new Error(`npm pack did not print JSON: ${packed.stdout}${packed.stderr}`);
  }
  assert.ok(info && info.filename, 'npm pack reported no filename');
  const tarball = path.join(tmp, info.filename);
  assert.ok(fs.existsSync(tarball), `npm pack did not write ${tarball}`);

  // The tarball, not the working tree, must carry the files a consumer needs.
  const files = new Set((info.files || []).map((file) => file.path));
  for (const required of ['index.js', 'index.d.ts', 'cli.js', 'package.json']) {
    assert.ok(files.has(required), `${required} is missing from the packed files: ${[...files].join(', ')}`);
  }

  const cjs = path.join(tmp, 'cjs');
  const esm = path.join(tmp, 'esm');
  writeProject(cjs, 'commonjs', {});
  writeProject(esm, 'module', {});
  install(cjs, tarball);
  install(esm, tarball);

  // CommonJS: the full public surface, sorted exactly.
  const cjsProbe = must(run([process.execPath, '-e', `
    const assert = require('node:assert');
    const mod = require('env-saaf');
    const keys = Object.keys(mod).sort();
    assert.deepStrictEqual(keys, ${JSON.stringify(EXPECTED_EXPORTS)});
    const env = mod.validateEnv({ PORT: { type: 'port', required: true } }, { PORT: '3000' });
    assert.strictEqual(env.PORT, 3000);
    console.log('cjs ok');
  `], cjs), 'the CommonJS consumer');
  assert.match(cjsProbe.stdout, /cjs ok/);

  // ESM: named exports must resolve from the installed CommonJS package.
  const esmProbe = must(run([process.execPath, '--input-type=module', '-e', `
    import assert from 'node:assert';
    import { validateEnv, EnvSaafError } from 'env-saaf';
    assert.strictEqual(typeof validateEnv, 'function');
    assert.strictEqual(typeof EnvSaafError, 'function');
    const env = validateEnv({ DEBUG: { type: 'boolean', default: false } }, {});
    assert.strictEqual(env.DEBUG, false);
    console.log('esm ok');
  `], esm), 'the ESM consumer');
  assert.match(esmProbe.stdout, /esm ok/);

  // The installed bin: --version, and a scan over a fixture through the
  // installed package rather than the repository.
  const bin = path.join(cjs, 'node_modules', '.bin', process.platform === 'win32' ? 'env-saaf.cmd' : 'env-saaf');
  assert.ok(fs.existsSync(bin), `the env-saaf bin was not installed at ${bin}`);
  const version = must(run([bin, '--version'], cjs), 'env-saaf --version');
  assert.match(version.stdout.trim(), /(?:^|\s)\d+\.\d+\.\d+/);

  writeProject(path.join(cjs, 'scan-fixture'), 'commonjs', { 'app.js': 'console.log(process.env.PACKED_KEY);\n' });
  const scan = must(run([bin, 'scan', '.', '--json'], path.join(cjs, 'scan-fixture')), 'env-saaf scan --json');
  assert.deepStrictEqual(JSON.parse(scan.stdout), { ok: true, vars: ['PACKED_KEY'] });

  // Types: a consumer file compiled against the installed declarations.
  writeProject(esm, 'module', {
    'consumer.ts': [
      "import { validateEnv, EnvSaafError } from 'env-saaf';",
      'const env = validateEnv({ PORT: { type: \'port\', required: true } });',
      'const port: number = env.PORT;',
      'const failure: EnvSaafError | null = null;',
      'void port; void failure;',
      '',
    ].join('\n'),
  });
  must(run([process.execPath, TSC, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext',
    '--target', 'es2022', 'consumer.ts'], esm), 'type-checking an installed consumer');

  console.log('test-pack.js: packaging smoke tests passed');
}

try {
  main();
} catch (error) {
  for (const failure of failures) console.error(failure);
  if (!failures.length) console.error(error.stack || String(error));
  process.exitCode = 1;
} finally {
  cleanup();
}
