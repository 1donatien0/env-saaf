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

// The types coerce() knows how to handle. Kept in one place so schema
// validation and coercion cannot drift apart when a new type is added.
const KNOWN_TYPES = new Set([
  'string', 'email', 'number', 'int', 'json', 'boolean', 'url',
  'uuid', 'hex', 'ipv4', 'semver', 'base64', 'port', 'date',
]);

// Validate the shape of the schema itself, independent of any env values.
// These checks used to live only inside the per-key coercion loop, so an
// invalid rule on an absent optional key was never reached and slipped through
// silently (issue #134). Errors name the key and the offending option.
function validateSchema(schema) {
  const errors = [];
  for (const [key, rule] of Object.entries(schema)) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) continue;
    if (rule.type !== undefined && !KNOWN_TYPES.has(rule.type)) {
      errors.push(`${key}: unknown type "${rule.type}"`);
    }
    if (rule.pattern !== undefined && !(rule.pattern instanceof RegExp)) {
      errors.push(`${key}: "pattern" must be a RegExp`);
    }
    if (rule.transform !== undefined && typeof rule.transform !== 'function') {
      errors.push(`${key}: "transform" must be a function`);
    }
    for (const opt of ['min', 'max']) {
      if (rule[opt] !== undefined && (typeof rule[opt] !== 'number' || !Number.isFinite(rule[opt]))) {
        errors.push(`${key}: "${opt}" must be a number`);
      }
    }
    for (const opt of ['minLength', 'maxLength']) {
      if (rule[opt] !== undefined && (!Number.isInteger(rule[opt]) || rule[opt] < 0)) {
        errors.push(`${key}: "minLength" and "maxLength" must be non-negative integers`);
      }
    }
    if (rule.length !== undefined && (!Number.isInteger(rule.length) || rule.length < 0)) {
      errors.push(`${key}: "length" must be a non-negative integer`);
    }
  }
  if (errors.length) throw new EnvSaafError(errors);
}

function coerce(key, raw, type, trim = true) {
  // trim: false (issue #84) keeps the raw value exactly as provided — for
  // values where the whitespace IS the value (a password with a significant
  // trailing space). The default stays true: stray spaces from pasted
  // secrets are trimmed. Numbers and booleans are unaffected either way —
  // Number() ignores surrounding whitespace, and the boolean spellings are
  // matched on the trimmed value below.
  const v = typeof raw === 'string' ? (trim ? raw.trim() : raw) : raw;
  switch (type) {
    case 'string': return String(v);
    case 'email': {
      // Pragmatic check, not full RFC 5322: one '@', a non-empty local
      // part and domain, a dot in the domain, and no whitespace.
      const s = String(v);
      const at = s.indexOf('@');
      if (at <= 0 || at !== s.lastIndexOf('@') || at === s.length - 1
        || !s.slice(at + 1).includes('.') || s.slice(at + 1).startsWith('.')
        || s.slice(at + 1).endsWith('.') || /\s/.test(s)) {
        throw new Error(`${key}: expected a valid email address, got "${raw}"`);
      }
      return s;
    }
    case 'number': {
      const n = Number(v);
      if (v === '' || Number.isNaN(n)) throw new Error(`${key}: expected a number, got "${raw}"`);
      return n;
    }
    case 'int': {
      // Whole numbers only: counts, retries, pool sizes. '1e3' is 1000, so
      // it passes; '3.5' and 'abc' do not.
      const n = Number(v);
      if (v === '' || Number.isNaN(n) || !Number.isInteger(n)) throw new Error(`${key}: expected an integer, got "${raw}"`);
      return n;
    }
    case 'json': {
      // Structured config in one variable: '{"beta":true,"maxItems":3}'.
      // Valid JSON of any shape (object, array, primitive) is parsed and
      // returned as-is; a non-string value (e.g. an object passed directly
      // in the env argument) is already parsed, so it passes through.
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); }
      catch { throw new Error(`${key}: expected valid JSON, got "${raw}"`); }
    }
    case 'boolean': {
      if (typeof v === 'boolean') return v;
      const s = String(v).trim().toLowerCase();
      if (['true', '1', 'yes', 'on', 'y'].includes(s)) return true;
      if (['false', '0', 'no', 'off', 'n'].includes(s)) return false;
      throw new Error(`${key}: expected a boolean (true/false, yes/no, on/off, 1/0, y/n), got "${raw}"`);
    }
    case 'url': {
      // Validate only — never modify: new URL(...).toString() normalizes
      // the value (a bare origin gains a trailing slash), which can break
      // the user's string comparisons.
      try { new URL(String(v)); }
      catch { throw new Error(`${key}: expected a valid URL, got "${raw}"`); }
      return String(v);
    }
    case 'uuid': {
      // Canonical UUID: 8-4-4-4-12 hex groups. Upper- and lowercase hex
      // are both accepted, and the value is returned exactly as provided.
      const s = String(v);
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) {
        throw new Error(`${key}: expected a valid UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx), got "${raw}"`);
      }
      return s;
    }
    case 'hex': {
      // Hex strings only: API tokens, colour codes, hashes. An empty
      // value never reaches here (it counts as missing), so '+' is right.
      const s = String(v);
      if (!/^[0-9a-fA-F]+$/.test(s)) {
        throw new Error(`${key}: expected a hexadecimal string, got "${raw}"`);
      }
      return s;
    }
    case 'ipv4': {
      // Dotted-quad IPv4: four decimal octets, each 0-255. A leading zero
      // is rejected (except a lone '0') because '010.0.0.1' is ambiguous —
      // some systems read it as octal. The value is returned unchanged.
      const s = String(v);
      const parts = s.split('.');
      const badOctet = parts.some(p => !/^(0|[1-9][0-9]*)$/.test(p) || Number(p) > 255);
      if (parts.length !== 4 || badOctet) {
        throw new Error(`${key}: expected a valid IPv4 address (e.g. 192.168.0.1), got "${raw}"`);
      }
      return s;
    }
    case 'semver': {
      // Semantic version: MAJOR.MINOR.PATCH, no leading 'v', no leading
      // zeroes in the numeric parts; pre-release and build suffixes are
      // allowed (1.2.3-beta.1, 1.2.3+build.5). Returned unchanged.
      const s = String(v);
      if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/.test(s)) {
        throw new Error(`${key}: expected a valid semantic version (e.g. 1.2.3), got "${raw}"`);
      }
      return s;
    }
    case 'base64': {
      // Standard base64 only: A-Za-z0-9+/ with '=' padding, total length
      // a multiple of 4. Base64url ('-' and '_') is not accepted. The
      // value is returned unchanged.
      const s = String(v);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s) || s.length === 0) {
        throw new Error(`${key}: expected a valid base64 string, got "${raw}"`);
      }
      return s;
    }
    case 'date': {
      // ISO 8601 dates and datetimes: '2026-01-31' or
      // '2026-01-31T10:00:00Z' (seconds, fractional seconds and a Z or
      // ±HH:MM offset are optional). Returns a Date. Impossible dates are
      // rejected — new Date() would silently roll '2026-02-31' over to
      // March, so the components are checked against the calendar first
      // (leap years included). A Date passed directly (e.g. as a default)
      // passes through when it is valid.
      if (v instanceof Date) {
        if (Number.isNaN(v.getTime())) throw new Error(`${key}: expected a valid ISO 8601 date (e.g. 2026-01-31), got "${raw}"`);
        return v;
      }
      const s = String(v);
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
      if (!m) {
        throw new Error(`${key}: expected a valid ISO 8601 date (e.g. 2026-01-31), got "${raw}"`);
      }
      const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
      const hour = m[4] === undefined ? 0 : Number(m[4]);
      const minute = m[5] === undefined ? 0 : Number(m[5]);
      const second = m[6] === undefined ? 0 : Number(m[6]);
      const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
      const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
      if (month < 1 || month > 12 || day < 1 || day > (daysInMonth || 0)
        || hour > 23 || minute > 59 || second > 59) {
        throw new Error(`${key}: expected a valid ISO 8601 date (e.g. 2026-01-31), got "${raw}"`);
      }
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) {
        throw new Error(`${key}: expected a valid ISO 8601 date (e.g. 2026-01-31), got "${raw}"`);
      }
      return d;
    }
    case 'port': {
      const n = Number(v);
      const zeroWithoutValue = n === 0 && typeof v !== 'number'
        && (typeof v !== 'string' || v.trim() === '');
      if (zeroWithoutValue || !Number.isInteger(n) || n < 0 || n > 65535) {
        throw new Error(`${key}: expected a port (0-65535), got "${raw}"`);
      }
      return n;
    }
    default: throw new Error(`${key}: unknown type "${type}"`);
  }
}

function validateEnv(schema, env = process.env, options = {}) {
  const out = {}; const errors = [];
  // Reject a malformed schema before looking at any values, so a typo on an
  // absent optional key fails immediately instead of passing silently.
  validateSchema(schema);
  if (options.strict) {
    for (const key of Object.keys(env)) {
      if (!Object.prototype.hasOwnProperty.call(schema, key) && env[key] !== undefined && env[key] !== '') {
        errors.push(`${key}: set but not in schema (strict mode)`);
      }
    }
  }
  for (const [key, rule] of Object.entries(schema)) {
    let raw = env[key];
    // A default goes through the same coercion and checks as a real value,
    // so a typo in it fails startup with the key named. A supplied value
    // still wins; transform is skipped for defaults (see below).
    let usingDefault = false;
    if (raw === undefined || raw === '') {
      if (rule.default !== undefined) { raw = rule.default; usingDefault = true; }
      else {
        if (rule.required) errors.push(`${key}: missing required variable`);
        continue;
      }
    }
    try {
      const val = coerce(key, raw, rule.type || 'string', rule.trim !== false);
      // min/max: allowed range for numeric values (number, int, port).
      // Runs right after coercion, before choices/pattern/transform; the
      // error names the allowed range. min alone or max alone both work.
      if (typeof val === 'number' && (rule.min !== undefined || rule.max !== undefined)) {
        const lo = rule.min !== undefined ? rule.min : -Infinity;
        const hi = rule.max !== undefined ? rule.max : Infinity;
        if (val < lo || val > hi) {
          const range = rule.min !== undefined && rule.max !== undefined ? `${rule.min}–${rule.max}`
            : rule.min !== undefined ? `at least ${rule.min}` : `at most ${rule.max}`;
          errors.push(`${key}: expected a number ${range}, got "${raw}"`);
          continue;
        }
      }
      // minLength/maxLength: allowed length for string values (string,
      // email, url, uuid, hex, ipv4, semver, base64). Checked after coercion, before choices/pattern; the
      // error names the allowed length. Either option works alone, and
      // non-string values skip the check entirely.
      if (typeof val === 'string' && (rule.minLength !== undefined || rule.maxLength !== undefined)) {
        if ((rule.minLength !== undefined && (!Number.isInteger(rule.minLength) || rule.minLength < 0))
          || (rule.maxLength !== undefined && (!Number.isInteger(rule.maxLength) || rule.maxLength < 0))) {
          errors.push(`${key}: "minLength" and "maxLength" must be non-negative integers`);
          continue;
        }
        const lo = rule.minLength !== undefined ? rule.minLength : 0;
        const hi = rule.maxLength !== undefined ? rule.maxLength : Infinity;
        if (val.length < lo || val.length > hi) {
          const range = rule.minLength !== undefined && rule.maxLength !== undefined ? `${rule.minLength}–${rule.maxLength} characters`
            : rule.minLength !== undefined ? `at least ${rule.minLength} characters` : `at most ${rule.maxLength} characters`;
          errors.push(`${key}: expected a string ${range} long, got "${raw}"`);
          continue;
        }
      }
      // length: exact length in characters for the hex type (fixed-size
      // tokens and hashes). Checked after coercion, before choices/pattern;
      // the error names the expected length.
      if (rule.type === 'hex' && rule.length !== undefined) {
        if (!Number.isInteger(rule.length) || rule.length < 0) {
          errors.push(`${key}: "length" must be a non-negative integer`);
          continue;
        }
        if (typeof val === 'string' && val.length !== rule.length) {
          errors.push(`${key}: expected a string ${rule.length} characters long, got "${raw}"`);
          continue;
        }
      }
      if (rule.choices && !rule.choices.includes(val)) {
        errors.push(`${key}: expected one of [${rule.choices.join(', ')}], got "${raw}"`);
        continue;
      }
      // pattern: a RegExp a string value must match (slugs, prefixed keys
      // like `sk_...`). Runs after coercion and the choices check, before
      // transform; other types skip it. A mismatch names the pattern.
      if (rule.pattern !== undefined) {
        if (!(rule.pattern instanceof RegExp)) {
          errors.push(`${key}: "pattern" must be a RegExp`);
          continue;
        }
        if (typeof val === 'string' && !rule.pattern.test(val)) {
          errors.push(`${key}: expected to match ${rule.pattern}, got "${raw}"`);
          continue;
        }
      }
      // transform: one custom step after coercion and the choices check.
      // It runs only on values actually provided (not on defaults, which are
      // still coerced and validated). A
      // throwing transform is collected like any other validation error,
      // with the key named — never thrown raw.
      if (rule.transform !== undefined && !usingDefault) {
        if (typeof rule.transform !== 'function') {
          errors.push(`${key}: "transform" must be a function`);
          continue;
        }
        try {
          out[key] = rule.transform(val);
        } catch (e) {
          errors.push(`${key}: transform failed: ${e.message}`);
        }
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
 *              (objects/arrays from the json type are JSON-stringified)
 *              (default false — process.env is never mutated silently)
 * Any other options are passed through to validateEnv (e.g. { strict: true }).
 * A missing file throws a clear error unless every schema key is optional
 * (has a default or is not required).
 */
function loadEnv(schema, options = {}) {
  if (schema === null || typeof schema !== 'object'
    || (Object.getPrototypeOf(schema) !== Object.prototype && Object.getPrototypeOf(schema) !== null)) {
    throw new TypeError(
      "loadEnv expects a schema object as the first argument — did you mean loadEnv(schema, { path: '.env' })?"
    );
  }
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
    for (const [key, value] of Object.entries(validated)) {
      // A json value (or a transform returning an object/array) must be written
      // back as JSON text so it round-trips through JSON.parse; String() on an
      // object would produce the useless "[object Object]".
      env[key] = (value !== null && typeof value === 'object') ? JSON.stringify(value) : String(value);
    }
  }
  return validated;
}

/** Parse .env text -> { KEY: value }. Handles quotes, `export `, comments,
 * multiline quoted values, and ${VAR} interpolation. */
/**
 * Index of the first `quote` in `text` that is not escaped by a backslash,
 * starting at `from`; -1 when the value is still unterminated (multiline).
 * A backslash escapes the single character after it, so `\\` before a quote
 * still lets that quote close the value.
 */
function closingQuoteIndex(text, quote, from = 1) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === quote) return i;
  }
  return -1;
}

function parseEnvFile(text) {
  // A file path passed by mistake (e.g. parseEnvFile('.env')) used to silently
  // return {} because no line matched KEY=VALUE. Detect that confusion: a
  // single-line string with no '=' that looks like a path is almost certainly
  // a path, not .env content. Real .env text has '=' or a newline (or is empty),
  // so none of those trip this guard.
  const input = String(text);
  if (!input.includes('\n') && !input.includes('=') && !input.trimStart().startsWith('#')) {
    const pathLike = input.startsWith('.')
      || input.startsWith('/') || input.startsWith('\\')
      || input.includes('/') || input.includes('\\')
      || /^[A-Za-z]:[\\/]/.test(input)
      || /\.(env|local|properties|config)$/i.test(input);
    if (pathLike) {
      throw new Error(
        "parseEnvFile expects .env text, not a file path — did you mean loadEnv(schema, { path: '.env' })?"
      );
    }
  }
  const seen = new Map();
  const raw = {};     // key -> value with quotes removed and comments stripped
  const quoteOf = {}; // key -> 'single' | 'double' | 'none'
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) {
      // Ignore an equals sign in an inline comment. Avoid echoing file contents.
      if (!t.split(/\s+#/, 1)[0].includes('=')) {
        throw new SyntaxError(`line ${i + 1}: expected KEY=VALUE`);
      }
      continue;
    }
    const key = m[1];
    if (seen.has(key)) {
      throw new Error(`env-saaf: duplicate key ${key} at line ${i + 1} (first defined at line ${seen.get(key)})`);
    }
    seen.set(key, i + 1);
    let val = m[2].trim();
    let quote = 'none';
    if (val.startsWith('"') || val.startsWith("'")) {
      // Quoted value: '#' inside quotes is safe; any comment after the closing
      // quote is dropped because only the quoted span is kept
      // (NAME="x # y" -> x # y; NAME="x" # note -> x)
      quote = val[0] === '"' ? 'double' : 'single';
      const q = val[0];
      let end = closingQuoteIndex(val, q);
      // Multiline value: the closing quote is not on this line, so keep
      // consuming lines (with their newlines) until it appears
      // (PRIVATE_KEY="-----BEGIN-----\n...\n-----END-----")
      while (end === -1 && i + 1 < lines.length) {
        i++;
        val += '\n' + lines[i];
        end = closingQuoteIndex(val, q);
      }
      // A backslash-escaped quote is part of the value, not the end of it
      // (B='it\'s' -> it's; D="it\"s" -> it"s). Both quote styles behave the
      // same way; other backslashes are left untouched (C:\path stays literal).
      const escapedQuote = String.fromCharCode(92) + q;
      val = end === -1 ? val.slice(1) : val.slice(1, end).split(escapedQuote).join(q);
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

// A masked character: a position inside a comment or a literal. It is neither
// code nor whitespace, so nothing matches across it and it never looks like code.
const MASKED = '\u0000';

// Keywords after which a `/` opens a regular expression literal, not a division.
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case',
  'do', 'else', 'yield', 'await', 'throw']);

// Punctuation after which a `/` opens a regular expression literal.
const REGEX_PUNCTUATION = '([{,;:=!&|?+-*%<>~^';

/**
 * The text of `src` with every comment and every literal's content turned into
 * MASKED, at the same offsets, so what is left is the code. A template literal's
 * `${...}` bodies stay code (a read inside one is a real read), and a newline
 * always survives, so the mask has the text's shape. A `/` where an expression
 * may start is read as a regular expression literal, so a quote inside it cannot
 * open a string (fixes #115).
 */
function codeOnly(src) {
  const out = src.split('');   // rewritten in place, so every offset stays where it was
  const stack = [{ mode: 'code', braces: 0 }];
  const top = () => stack[stack.length - 1];
  const mayStartRegex = (prev, word) => REGEX_AFTER.has(word)
    || (!word && (!prev || REGEX_PUNCTUATION.includes(prev)));
  // A newline is never masked: the mask keeps the text's shape for anything that
  // reads it line by line.
  const mask = (at) => {
    if (at < src.length && src[at] !== '\n' && src[at] !== '\r') out[at] = MASKED;
  };
  let prev = '';   // the last code character
  let word = '';   // the identifier or keyword just read in code
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '\n' || c === '\r') { i++; continue; }
    if (top().mode === 'template') {
      if (c === '\\') { mask(i); mask(i + 1); i += 2; continue; }
      if (c === '`') { stack.pop(); mask(i); i++; prev = '`'; word = ''; continue; }
      if (c === '$' && n === '{') {
        stack.push({ mode: 'code', braces: 0 }); i += 2; prev = '{'; word = ''; continue;
      }
      mask(i); i++; continue;
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') { mask(i); i++; }
      continue;
    }
    if (c === '/' && n === '*') {
      mask(i); mask(i + 1); i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { mask(i); i++; }
      if (i < src.length) { mask(i); mask(i + 1); i += 2; }
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      mask(i); i++;
      while (i < src.length) {
        if (src[i] === '\n') break;   // an unterminated string ends at the line
        if (src[i] === '\\') { mask(i); mask(i + 1); i += 2; continue; }
        const ch = src[i]; mask(i); i++;
        if (ch === quote) break;
      }
      prev = quote; word = ''; continue;
    }
    if (c === '`') { stack.push({ mode: 'template' }); mask(i); i++; prev = '`'; word = ''; continue; }
    if (c === '/' && mayStartRegex(prev, word)) {
      mask(i); i++;
      let inClass = false;
      while (i < src.length) {
        const ch = src[i];
        if (ch === '\n') break;
        if (ch === '\\') { mask(i); mask(i + 1); i += 2; continue; }
        mask(i); i++;
        if (ch === '[') inClass = true;
        else if (ch === ']') inClass = false;
        else if (ch === '/' && !inClass) break;
      }
      prev = '/'; word = ''; continue;
    }
    if (c === '{') { top().braces++; i++; prev = c; word = ''; continue; }
    if (c === '}') {
      if (top().braces === 0 && stack.length > 1) stack.pop();   // the end of a `${...}`
      else top().braces = Math.max(0, top().braces - 1);
      i++; prev = c; word = ''; continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) { word += c; prev = c; }
    else if (!/\s/.test(c)) { word = ''; prev = c; }   // whitespace leaves both as they were
    i++;
  }
  return out.join('');
}

/** Find every process.env.KEY usage in JS/TS source text. Returns sorted unique names. */
function scanCode(text) {
  const src = String(text);
  const code = codeOnly(src);
  const isCode = (start, end) => {
    for (let i = start; i < end; i++) if (code[i] === MASKED) return false;
    return true;
  };
  const found = new Set();
  const patterns = [
    /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
    /process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g,
    // Backtick bracket access with a plain identifier — `process.env[`KEY`]`:
    // a template with ${} interpolation cannot be known statically and
    // stays unmatched (the identifier charset excludes $ and {).
    /process\.env\[`([A-Za-z_][A-Za-z0-9_]*)`\]/g,
  ];
  // The read itself must be code: a `process.env.X` in a comment or a string is
  // not a read. Bracket and destructured reads keep their key in a literal, so
  // only the `process.env` they hang off has to be code.
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      if (isCode(m.index, m.index + 'process.env'.length)) found.add(m[1]);
    }
  }
  const codeView = code.split(MASKED).join(' ');
  const destructure = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*process\.env/g;
  for (const m of codeView.matchAll(destructure)) {
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
  // A key that looks like a secret gets an empty placeholder — there is
  // nothing safe to suggest for it. Whole underscore-separated words only:
  // API_KEY and DB_PASSWORD match, but MONKEY does not (it merely contains
  // "KEY"). An explicit default still wins — the schema author chose it.
  const SECRET_WORDS = new Set(['SECRET', 'KEY', 'TOKEN', 'PASSWORD', 'PASSWD', 'PRIVATE', 'CREDENTIAL']);
  const lines = ['# Generated by env-saaf — put real values in .env (never commit .env)'];
  for (const [key, rule] of Object.entries(schema)) {
    lines.push(`# type: ${rule.type || 'string'}${rule.required ? ', required' : ''}${rule.choices ? ', one of: ' + rule.choices.join('|') : ''}`);
    const looksSecret = key.split('_').some(part => SECRET_WORDS.has(part.toUpperCase()));
    const placeholder = rule.default !== undefined ? rule.default
      : looksSecret ? ''
      : (rule.type === 'port' ? 3000 : rule.type === 'url' ? 'https://example.com'
        : rule.type === 'ipv4' ? '192.168.0.1' : rule.type === 'semver' ? '1.0.0'
        : rule.type === 'date' ? '2026-01-31' : 'your_value_here');
    lines.push(`${key}=${placeholder}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { validateEnv, loadEnv, EnvSaafError, parseEnvFile, scanCode, scanDir, diffEnv, maskValue, maskSecrets, generateExample };
