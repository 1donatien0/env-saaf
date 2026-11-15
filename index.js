'use strict';
/**
 * env-saaf — zero-dependency env validator.
 * v0.2.0 adds: parseEnvFile, scanCode (process.env usage in code),
 * diffEnv (used vs documented), and a CLI (bin: env-saaf).
 * v0.1.0 core: validateEnv with typed coercion.
 */
const fs = require('node:fs');
const path = require('node:path');

class EnvSaafError extends Error {
  constructor(errors) {
    super('Invalid environment variables:\n' + errors.map(e => `  - ${e}`).join('\n'));
    this.name = 'EnvSaafError';
    this.errors = errors;
  }
}

function coerce(key, raw, type) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  switch (type) {
    case 'string': return String(v);
    case 'number': {
      const n = Number(v);
      if (v === '' || Number.isNaN(n)) throw new Error(`${key}: expected a number, got "${raw}"`);
      return n;
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).toLowerCase();
      if (['true', '1', 'yes', 'on', 'y'].includes(s)) return true;
      if (['false', '0', 'no', 'off', 'n'].includes(s)) return false;
      throw new Error(`${key}: expected a boolean (true/false, yes/no, on/off, 1/0, y/n), got "${raw}"`);
    }
    case 'url': {
      // Validate karke ASLI string hi lautaao. new URL(...).toString() value ko
      // normalizes the value (a bare origin gains a trailing slash), which can
      // break the user's string comparisons — so validate only, never modify.
      try { new URL(String(v)); }
      catch { throw new Error(`${key}: expected a valid URL, got "${raw}"`); }
      return String(v);
    }
    case 'port': {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key}: expected a port (1-65535), got "${raw}"`);
      return n;
    }
    default: throw new Error(`${key}: unknown type "${type}"`);
  }
}

function validateEnv(schema, env = process.env, options = {}) {
  const out = {}; const errors = [];
  if (options.strict) {
    for (const key of Object.keys(env)) {
      if (!Object.prototype.hasOwnProperty.call(schema, key) && env[key] !== undefined && env[key] !== '') {
        errors.push(`${key}: set but not in schema (strict mode)`);
      }
    }
  }
  for (const [key, rule] of Object.entries(schema)) {
    const raw = env[key];
    if (raw === undefined || raw === '') {
      if (rule.default !== undefined) { out[key] = rule.default; continue; }
      if (rule.required) errors.push(`${key}: missing required variable`);
      continue;
    }
    try {
      const val = coerce(key, raw, rule.type || 'string');
      if (rule.choices && !rule.choices.includes(val)) {
        errors.push(`${key}: expected one of [${rule.choices.join(', ')}], got "${raw}"`);
        continue;
      }
      out[key] = val;
    } catch (e) { errors.push(e.message); }
  }
  if (errors.length) throw new EnvSaafError(errors);
  return Object.freeze(out);
}

/**
 * Load a .env file and validate it in one call.
 * Options:
 *   path     — .env file to read (default '.env')
 *   env      — base env to merge with (default process.env); its values win unless override is true
 *   override — if true, values from the file win over `env` (default false)
 *   assign   — if true, write the validated values back into `env` as strings
 *              (default false — process.env is never mutated silently)
 * Any other options are passed through to validateEnv (e.g. { strict: true }).
 * A missing file throws a clear error unless every schema key is optional
 * (has a default or is not required).
 */
function loadEnv(schema, options = {}) {
  const { path: pathOpt = '.env', paths: pathsOpt, env = process.env, override = false, assign = false, ...rest } = options;
  // One file or several: `path` may be a string or an array of strings, or
  // pass `paths: [...]`. Files are read in order and LATER files win over
  // earlier ones (e.g. ['.env', '.env.local']). Missing files in a list are
  // skipped; only when NO file is found does the missing-file rule below run.
  const fileList = pathsOpt !== undefined ? pathsOpt : (Array.isArray(pathOpt) ? pathOpt : [pathOpt]);
  const fileEnv = {};
  let foundAny = false;
  for (const filePath of fileList) {
    let fileText;
    try {
      fileText = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      continue;
    }
    foundAny = true;
    Object.assign(fileEnv, parseEnvFile(fileText));
  }
  if (!foundAny) {
    const needed = Object.entries(schema)
      .filter(([, rule]) => rule.required && rule.default === undefined)
      .map(([key]) => key);
    if (needed.length) {
      throw new Error(`env-saaf: .env file not found: ${fileList.join(', ')} (required variables missing: ${needed.join(', ')})`);
    }
  }
  const merged = override ? { ...env, ...fileEnv } : { ...fileEnv, ...env };
  const validated = validateEnv(schema, merged, rest);
  if (assign) {
    for (const [key, value] of Object.entries(validated)) env[key] = String(value);
  }
  return validated;
}

/** Parse .env text -> { KEY: value }. Handles quotes, `export `, comments,
 * multiline quoted values, and ${VAR} interpolation. */
function parseEnvFile(text) {
  const raw = {};     // key -> value with quotes removed and comments stripped
  const quoteOf = {}; // key -> 'single' | 'double' | 'none'
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    let quote = 'none';
    if (val.startsWith('"') || val.startsWith("'")) {
      // Quoted value: '#' inside quotes is safe; any comment after the closing
      // quote is dropped because only the quoted span is kept
      // (NAME="x # y" -> x # y; NAME="x" # note -> x)
      quote = val[0] === '"' ? 'double' : 'single';
      const q = val[0];
      let end = val.indexOf(q, 1);
      // Multiline value: the closing quote is not on this line, so keep
      // consuming lines (with their newlines) until it appears
      // (PRIVATE_KEY="-----BEGIN-----\n...\n-----END-----")
      while (end === -1 && i + 1 < lines.length) {
        i++;
        val += '\n' + lines[i];
        end = val.indexOf(q, 1);
      }
      val = end === -1 ? val.slice(1) : val.slice(1, end);
    } else {
      // Unquoted value: a '#' at the start of the value or after whitespace begins an inline comment
      // (PORT=3000 # my port -> 3000; a '#frag' inside a URL without a preceding space is safe)
      const hash = val.search(/(^|\s)#/);
      if (hash !== -1) val = val.slice(0, hash).trim();
    }
    raw[key] = val;
    quoteOf[key] = quote;
  }
  // Interpolation: ${VAR} inside double-quoted and unquoted values expands
  // from values defined in this file first, then process.env. Single-quoted
  // values stay literal. \${VAR} is an escape and also stays literal. Unknown
  // names expand to an empty string. Expansion repeats (at most 5 rounds) so
  // a value may reference another interpolated value; cycles stop at the cap.
  const ESC = String.fromCharCode(92) + '${'; // literal backslash + ${ — an escaped reference
  const PH = String.fromCharCode(1); // placeholder char that cannot appear in real .env text
  const expandRefs = (s) => s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) =>
    Object.prototype.hasOwnProperty.call(raw, name) ? raw[name].split(ESC).join(PH)
      : (process.env[name] !== undefined ? process.env[name] : ''));
  const out = {};
  for (const [key, val] of Object.entries(raw)) {
    if (quoteOf[key] === 'single') { out[key] = val; continue; }
    // Escapes are protected BEFORE the rounds and restored only AFTER them,
    // so a restored ${VAR} is never re-expanded by a later round.
    let v = val.split(ESC).join(PH);
    for (let round = 0; round < 5; round++) {
      const next = expandRefs(v);
      if (next === v) break;
      v = next;
    }
    out[key] = v.split(PH).join('${');
  }
  return out;
}

/** Find every process.env.KEY usage in JS/TS source text. Returns sorted unique names. */
function scanCode(text) {
  const found = new Set();
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
  ];
  for (const re of patterns) for (const m of String(text).matchAll(re)) found.add(m[1]);
  const destructure = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g;
  for (const m of String(text).matchAll(destructure)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':')[0].split('=')[0].trim();
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) found.add(name);
    }
  }
  return [...found].sort();
}

/** Scan a folder (recursive, .js/.cjs/.mjs/.ts) for env usage. */
function scanDir(dir) {
  const found = new Set();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|cjs|mjs|ts|mts|cts|tsx|jsx)$/.test(e.name)) scanCode(fs.readFileSync(p, 'utf8')).forEach(k => found.add(k));
    }
  };
  walk(dir);
  return [...found].sort();
}

/** Compare code usage vs a documented set (e.g. keys of .env.example). */
function diffEnv(usedKeys, documentedKeys) {
  const doc = new Set(documentedKeys);
  const used = new Set(usedKeys);
  return {
    usedNotDocumented: usedKeys.filter(k => !doc.has(k)),
    documentedNotUsed: documentedKeys.filter(k => !used.has(k)),
  };
}

/** Mask a secret for safe logging: "sk_live_123456" -> "sk***56". Short values are fully masked. */
function maskValue(v) {
  const s = String(v);
  if (s.length <= 4) return '****';
  return s.slice(0, 2) + '***' + s.slice(-2);
}

/** Return a copy of an env object with every value masked — safe to print/log. */
function maskSecrets(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = maskValue(v);
  return out;
}

/** Generate .env.example text from a schema. Values are placeholders/defaults only — never real secrets. */
function generateExample(schema) {
  const lines = ['# Generated by env-saaf — put real values in .env (never commit .env)'];
  for (const [key, rule] of Object.entries(schema)) {
    lines.push(`# type: ${rule.type || 'string'}${rule.required ? ', required' : ''}${rule.choices ? ', one of: ' + rule.choices.join('|') : ''}`);
    const placeholder = rule.default !== undefined ? rule.default : (rule.type === 'port' ? 3000 : rule.type === 'url' ? 'https://example.com' : 'your_value_here');
    lines.push(`${key}=${placeholder}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { validateEnv, loadEnv, EnvSaafError, parseEnvFile, scanCode, scanDir, diffEnv, maskValue, maskSecrets, generateExample };
