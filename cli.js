#!/usr/bin/env node
'use strict';
/**
 * env-saaf CLI
 *   env-saaf check [dir] [--file name] [--schema file] [--json] — scan code for process.env usage, compare with
 *                           .env.example (or the --file given); exit 1 if anything
 *                           used is not documented. --schema also validates the values
 *                           of the real .env file against the schema the file exports
 *                           (issue #90); --json emits machine-readable output.
 *   env-saaf scan  [dir] [--file name] [--json]  — just list the env vars your code uses; keys in
 *                           .env.example (or the --file given) that no code reads are reported
 *                           as UNUSED warnings (stderr; `unused` in --json), never an exit code
 *   env-saaf example [dir] [--write[=file]] [--force] — print a .env.example draft from code
 *                           usage (v1.0.0); --write saves it to .env.example (or the file
 *                           named) instead, refusing to overwrite unless --force is given
 */
const fs = require('node:fs');
const path = require('node:path');
const { scanDir, parseEnvFile, diffEnv, validateEnv, EnvSaafError } = require('./index');

const argv = process.argv.slice(2);
// --version / -v is global: report the installed version wherever it appears, before anything else runs
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(`env-saaf ${require('./package.json').version}`);
  process.exit(0);
}
// Output is already plain in every mode, including when NO_COLOR is set.
while (argv[0] === '--no-color') argv.shift();
const cmd = argv[0];
const USAGE = 'Usage: env-saaf check [dir] [--file name] [--schema file] [--json] | env-saaf scan [dir] [--file name] [--json] | env-saaf example [dir] [--write[=file]] [--force]\n'
  + 'Global options: --no-color, --version / -v (before or after the command).';
// --help / -h / help: print usage and exit 0 (asking for help is not an error — this used to exit 2)
if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  console.log(USAGE);
  process.exit(0);
}
// --file <name> or --file=<name> ('check' and 'scan'): which template file to compare against
// --schema <file> or --schema=<file> ('check' only): validate the env values against the
// schema the file exports (issue #90). Opt-in: without it the check is presence-only.
// --json: machine-readable output for check and scan
// --write / --write=<file> ('example' only): save the draft to .env.example (or the file
// named) instead of printing it; --force allows overwriting an existing file
let fileOpt = '.env.example';
let fileExplicit = false;
let schemaOpt = null;
let jsonMode = false;
let writeOpt = null;
let forceOpt = false;
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  // --help / -h anywhere after the command: asking for help is never a directory
  if (a === '--help' || a === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  if (a === '--file' && argv[i + 1]) { fileOpt = argv[++i]; fileExplicit = true; }
  else if (a.startsWith('--file=')) { fileOpt = a.slice('--file='.length); fileExplicit = true; }
  else if (a === '--schema' && argv[i + 1]) schemaOpt = argv[++i];
  else if (a.startsWith('--schema=')) schemaOpt = a.slice('--schema='.length);
  else if (a === '--json') jsonMode = true;
  else if (a === '--write') writeOpt = '.env.example';
  else if (a.startsWith('--write=')) writeOpt = a.slice('--write='.length) || '.env.example';
  else if (a === '--force') forceOpt = true;
  else if (a !== '--no-color') positional.push(a);
}
const dir = positional[0] || process.cwd();

// Issue #133: validate the directory argument before any command uses it.
// scanDir's readdirSync otherwise throws a raw Node stack trace for a file
// path or a missing directory. Report a clear message and exit 2 instead.
if (cmd === 'scan' || cmd === 'check' || cmd === 'example') {
  const invalidDir = !fs.existsSync(dir)
    ? `${dir} does not exist`
    : !fs.statSync(dir).isDirectory() ? `${dir} is not a directory` : null;
  if (invalidDir) {
    const message = `env-saaf: ${invalidDir}`;
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: message }));
    } else {
      console.error(message);
    }
    process.exit(2);
  }
}

if (cmd === 'scan') {
  const vars = scanDir(dir);
  // Issue #63: the reverse drift — keys declared in the template that no code reads any more.
  // Only a warning: stdout stays the plain list of used vars and the exit code is unchanged.
  // Without a template file there is nothing to compare, so the output is exactly as before.
  const templatePath = path.join(dir, fileOpt);
  let unused = null;
  if (fs.existsSync(templatePath) && fs.statSync(templatePath).isFile()) {
    const declared = Object.keys(parseEnvFile(fs.readFileSync(templatePath, 'utf8')));
    unused = diffEnv(vars, declared).documentedNotUsed;
  }
  if (jsonMode) {
    const result = { ok: true, vars };
    if (unused) result.unused = unused;
    console.log(JSON.stringify(result));
  } else {
    console.log(vars.join('\n'));
    if (unused) unused.forEach(k => console.error(`UNUSED: ${k} (in ${fileOpt}, never used in code)`));
  }
} else if (cmd === 'check') {
  const examplePath = path.join(dir, fileOpt);
  if (!fs.existsSync(examplePath)) {
    // Issue #89: point at the command that drafts the file instead of dead-ending
    // a new user. --json keeps stdout parseable, so the hint travels as a field.
    const hint = `run \`env-saaf example\` to draft one, or generate it from your schema with generateExample()`;
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: `${fileOpt} not found in ${dir}`, hint }));
    } else {
      console.error(`env-saaf: ${fileOpt} not found in ${dir} — ${hint}`);
    }
    process.exit(2);
  }
  const documented = Object.keys(parseEnvFile(fs.readFileSync(examplePath, 'utf8')));
  const used = scanDir(dir);
  const { usedNotDocumented, documentedNotUsed } = diffEnv(used, documented);
  // The real .env is not committed, so only compare keys when it is actually present
  const envPath = path.join(dir, '.env');
  let envExtra = [];
  let envMissing = [];
  if (fs.existsSync(envPath)) {
    const envKeys = Object.keys(parseEnvFile(fs.readFileSync(envPath, 'utf8')));
    const envDiff = diffEnv(envKeys, documented);
    envExtra = envDiff.usedNotDocumented;
    envMissing = envDiff.documentedNotUsed;
  }
  // Issue #90: --schema validates the values of the real env file against the
  // schema the file exports (module.exports = { PORT: { type: 'port', ... } }).
  // An explicit --file names the file to validate; otherwise the real .env wins
  // when present — the template's placeholders are not real values, so with no
  // .env and no explicit --file there is nothing real to validate and the step
  // is skipped. Failures land in the existing `invalid` field (the library's
  // errors already name the key) and fail the check like a missing key.
  let invalid = [];
  if (schemaOpt) {
    let schema;
    try {
      // Like --file, a relative schema path is relative to the checked directory.
      schema = require(path.resolve(dir, schemaOpt));
    } catch (e) {
      const message = `env-saaf: cannot load schema ${schemaOpt}: ${e.message}`;
      if (jsonMode) console.log(JSON.stringify({ ok: false, error: message }));
      else console.error(message);
      process.exit(2);
    }
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
      const message = `env-saaf: schema ${schemaOpt} must export a schema object (module.exports = { KEY: { type: 'port', ... } })`;
      if (jsonMode) console.log(JSON.stringify({ ok: false, error: message }));
      else console.error(message);
      process.exit(2);
    }
    const targetName = fileExplicit ? fileOpt : (fs.existsSync(envPath) ? '.env' : null);
    if (targetName) {
      const values = parseEnvFile(fs.readFileSync(path.join(dir, targetName), 'utf8'));
      try {
        validateEnv(schema, values);
      } catch (e) {
        if (e instanceof EnvSaafError) invalid = e.errors;
        else throw e;
      }
    }
  }
  const ok = usedNotDocumented.length === 0 && documentedNotUsed.length === 0
    && envExtra.length === 0 && envMissing.length === 0 && invalid.length === 0;
  if (jsonMode) {
    const result = {
      ok,
      missing: usedNotDocumented,
      extra: documentedNotUsed,
      invalid,
      envExtra,
      envMissing,
    };
    console.log(JSON.stringify(result));
  } else {
    usedNotDocumented.forEach(k => console.log(`MISSING in ${fileOpt}: ${k} (used in code)`));
    documentedNotUsed.forEach(k => console.log(`UNUSED: ${k} (in ${fileOpt}, never used in code)`));
    envExtra.forEach(k => console.log(`EXTRA in .env: ${k} (not in ${fileOpt})`));
    envMissing.forEach(k => console.log(`MISSING in .env: ${k} (in ${fileOpt}, not set locally)`));
    invalid.forEach(e => console.log(`INVALID: ${e}`));
    if (!usedNotDocumented.length && !documentedNotUsed.length && !envExtra.length && !envMissing.length && !invalid.length) {
      console.log(`env-saaf: all clean — code and ${fileOpt} match.`);
    }
  }
  // Issue #113: the exit code follows the same `ok` the JSON output reports, so a
  // typo'd key in .env (EXTRA / MISSING), or a documented-but-unused key, can no
  // longer print a finding and still pass a CI job. UNUSED counts as a finding.
  process.exit(ok ? 0 : 1);
} else if (cmd === 'example') {
  // v1.0.0: draft a .env.example from a code scan (placeholder values only)
  const used = scanDir(dir);
  const lines = ['# Generated by env-saaf from code scan — fill real values in .env'];
  used.forEach(k => lines.push(`${k}=`));
  if (writeOpt === null) {
    console.log(lines.join('\n'));
  } else {
    const target = path.join(dir, writeOpt);
    if (fs.existsSync(target) && !forceOpt) {
      console.error(`env-saaf: ${writeOpt} already exists in ${dir} — pass --force to overwrite it`);
      process.exit(1);
    }
    fs.writeFileSync(target, lines.join('\n') + '\n');
    console.log(`env-saaf: wrote ${writeOpt} (${used.length} variable${used.length === 1 ? '' : 's'})`);
  }
} else {
  console.log(USAGE);
  process.exit(cmd ? 2 : 0);
}
