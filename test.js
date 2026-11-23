'use strict';
const assert = require('node:assert');
const { loadEnv, validateEnv, EnvSaafError, parseEnvFile, scanCode, diffEnv, maskSecrets, maskValue, generateExample, toJsonSchema } = require('./index');

// Issue #229: JSON Schema export
{
  const draft = 'https://json-schema.org/draft/2020-12/schema';
  assert.deepStrictEqual(toJsonSchema({ PORT: { type: 'port', required: true } }), {
    $schema: draft,
    type: 'object',
    properties: { PORT: { type: 'integer', minimum: 0, maximum: 65535 } },
    required: ['PORT'],
  });
  assert.deepStrictEqual(toJsonSchema({}), { $schema: draft, type: 'object', properties: {} });

  const types = {
    string: { type: 'string' },
    number: { type: 'number' },
    int: { type: 'integer' },
    boolean: { type: 'boolean' },
    url: { type: 'string', format: 'uri' },
    port: { type: 'integer', minimum: 0, maximum: 65535 },
    email: { type: 'string', format: 'email' },
    json: {},
    uuid: { type: 'string', format: 'uuid' },
    hex: { type: 'string', pattern: '^[0-9a-fA-F]+$' },
    ipv4: { type: 'string', format: 'ipv4' },
    semver: { type: 'string' },
    base64: { type: 'string' },
    date: { type: 'string', anyOf: [{ format: 'date' }, { format: 'date-time' }] },
    file: { type: 'string' },
    duration: { type: 'number', minimum: 0 },
    host: { type: 'string', anyOf: [{ format: 'hostname' }, { format: 'ipv4' }, { format: 'ipv6' }] },
    array: { type: 'array', items: { type: 'string', minLength: 1 } },
  };
  const rules = Object.fromEntries(Object.keys(types).map(type => [type, { type }]));
  assert.deepStrictEqual(toJsonSchema(rules).properties, types);

  const options = toJsonSchema({
    MODE: { required: true, minLength: 0, maxLength: 6, pattern: /^\w+$/, choices: ['local', 'test', 'local'] },
    RETRIES: { type: 'int', min: 0, max: 5, choices: [0, 2], default: '0' },
    RATIO: { type: 'number', min: -0.5, max: 0 },
    FEATURE: { type: 'boolean', choices: [false, true], default: 'no' },
    PAYLOAD: { type: 'json', max: 0, choices: ['text', false, 0, null] },
    PORT: { type: 'port', min: 1000, max: 99999 },
    NARROW_PORT: { type: 'port', min: -1, max: 1024 },
    TIMEOUT: { type: 'duration', min: -1, max: 100000, default: '1m30s' },
    HEX: { type: 'hex', length: 4, minLength: 2, maxLength: 6, pattern: /^fe/ },
    PORTS: { type: 'array', of: 'port', minItems: 0, maxItems: 2, separator: ';', default: '0;443' },
    EMPTY: { type: 'array', maxItems: 0, default: [] },
    RAW: { trim: false, default: ' text ', max: 1, length: 1 },
  });
  assert.deepStrictEqual(options.required, ['MODE']);
  assert.deepStrictEqual(options.properties, {
    MODE: { type: 'string', minLength: 0, maxLength: 6, pattern: '^\\w+$', enum: ['local', 'test'] },
    RETRIES: { type: 'integer', minimum: 0, maximum: 5, enum: [0, 2], default: 0 },
    RATIO: { type: 'number', minimum: -0.5, maximum: 0 },
    FEATURE: { type: 'boolean', enum: [false, true], default: false },
    PAYLOAD: { maximum: 0, enum: ['text', false, 0, null] },
    PORT: { type: 'integer', minimum: 1000, maximum: 65535 },
    NARROW_PORT: { type: 'integer', minimum: 0, maximum: 1024 },
    TIMEOUT: { type: 'number', minimum: 0, maximum: 100000, default: 90000 },
    HEX: { type: 'string', minLength: 4, maxLength: 4, pattern: '^fe', allOf: [{ pattern: '^[0-9a-fA-F]+$' }] },
    PORTS: { type: 'array', minItems: 0, maxItems: 2, default: [0, 443], items: { type: 'integer', minimum: 0, maximum: 65535 } },
    EMPTY: { type: 'array', maxItems: 0, default: [], items: { type: 'string', minLength: 1 } },
    RAW: { type: 'string', default: ' text ' },
  });

  const urls = toJsonSchema({
    URL: { type: 'url', protocols: ['HTTPS:', 'git+ssh', 'tool.v1-4'], pattern: /example\.org/ },
    MIRRORS: { type: 'array', of: 'url', protocols: ['https'] },
  }).properties;
  assert.strictEqual(urls.URL.pattern, 'example\\.org');
  const schemes = new RegExp(urls.URL.allOf[0].pattern, 'u');
  for (const url of ['https://x', 'HTTPS://x', 'git+SSH://x', 'tool.V1-4:x']) assert.match(url, schemes);
  for (const url of ['http://x', 'gitXssh://x', 'toolXv1-4:x', 'prefix-https://x']) assert.doesNotMatch(url, schemes);
  assert.strictEqual(urls.MIRRORS.items.format, 'uri');
  const itemScheme = new RegExp(urls.MIRRORS.items.pattern, 'u');
  assert.match('https://x', itemScheme);
  assert.doesNotMatch('http://x', itemScheme);

  const data = Object.freeze({ ['__proto__']: Object.freeze({ enabled: true }), count: 0 });
  let calls = 0;
  const callback = () => { calls++; throw new Error('must not run'); };
  const flagged = /ok/gi;
  flagged.lastIndex = 2;
  const source = Object.freeze({
    ['__proto__']: Object.freeze({ type: 'json', default: data, required: true }),
    constructor: { type: 'date', default: '2026-01-31' },
    toString: { type: 'date', default: new Date('2026-02-01T02:00:00+02:00') },
    toJSON: { type: 'json', default: '[false, null, 0]' },
    'slash/~': { type: 'file', default: './not-a-real-file.example', required: true },
    '': { default: '', required: false },
    FLAGS: { pattern: flagged, validate: callback, transform: callback, aliases: ['OLD'], requiredIf: { key: 'SWITCH', equals: 'enabled' } },
  });
  const result = toJsonSchema(source);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepStrictEqual(Object.keys(result.properties), Object.keys(source));
  assert.deepStrictEqual(result.required, ['__proto__', 'slash/~']);
  assert.deepStrictEqual(result.properties.__proto__.default, data);
  assert.notStrictEqual(result.properties.__proto__.default, data);
  assert.notStrictEqual(result.properties.__proto__.default.__proto__, data.__proto__);
  assert.strictEqual(result.properties.__proto__.default.__proto__.enabled, true);
  assert.strictEqual(result.properties.constructor.default, '2026-01-31T00:00:00.000Z');
  assert.strictEqual(result.properties.toString.default, '2026-02-01T00:00:00.000Z');
  assert.deepStrictEqual(result.properties.toJSON.default, [false, null, 0]);
  assert.strictEqual(result.properties['slash/~'].default, './not-a-real-file.example');
  assert.strictEqual(result.properties[''].default, '');
  assert.deepStrictEqual(result.properties.FLAGS, { type: 'string' });
  assert.strictEqual(calls, 0);
  assert.strictEqual(flagged.lastIndex, 2);

  const circular = {};
  circular.self = circular;
  const unrepresentable = toJsonSchema({
    BAD_JSON: { type: 'json', default: '{' },
    CIRCULAR: { type: 'json', default: circular },
    NON_FINITE: { type: 'json', default: { count: Infinity } },
    UNDEFINED: { type: 'json', default: [undefined] },
    CUSTOM: { type: 'json', default: { toJSON: callback } },
    CLASS_INSTANCE: { type: 'json', default: new RegExp('not JSON data') },
    GETTER: { type: 'json', default: Object.defineProperty({}, 'value', { get: callback, enumerable: true }) },
    INVALID_DATE: { type: 'date', default: new Date(NaN) },
    LOCAL_TIME: { type: 'date', default: '2026-01-31T10:00' },
    BAD_NUMBER: { type: 'number', default: '0x10' },
    BAD_ITEMS: { type: 'array', of: 'file', default: ['example.txt', ''] },
    NULL_ITEM: { type: 'array', of: 'int', default: [null] },
    SPARSE: { type: 'array', default: Array(1) },
  });
  for (const property of Object.values(unrepresentable.properties)) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(property, 'default'), false);
  }
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(toJsonSchema({
    FILES: { type: 'array', of: 'file', default: ['./example.txt'] },
    DATES: { type: 'array', of: 'date', default: ['2026-01-31T10:00Z'] },
    CONFIG: { type: 'json', default: null },
    DICTIONARY: { type: 'json', default: Object.assign(Object.create(null), { enabled: false }) },
    MIXED: { type: 'array', of: 'int', default: [0, '2'] },
    SPACES: { type: 'array', trim: false, default: ' x , ' },
    COUNT: { type: 'int', choices: [2, Infinity, 0, NaN] },
    UNSUPPORTED: { type: 'json', choices: [Infinity] },
  }).properties, {
    FILES: { type: 'array', items: { type: 'string' }, default: ['./example.txt'] },
    DATES: { type: 'array', items: types.date, default: ['2026-01-31T10:00:00.000Z'] },
    CONFIG: { default: null },
    DICTIONARY: { default: { enabled: false } },
    MIXED: { type: 'array', items: { type: 'integer' }, default: [0, 2] },
    SPACES: { type: 'array', items: { type: 'string', minLength: 1 }, default: [' x ', ' '] },
    COUNT: { type: 'integer', enum: [2, 0] },
    UNSUPPORTED: {},
  });
  assert.throws(() => toJsonSchema({ BROKEN: { type: 'port', min: NaN } }), EnvSaafError);

  // Issue #262: grouped schemas nest as object schemas instead of collapsing to `string`.
  assert.deepStrictEqual(toJsonSchema({
    DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true }, PORT: { type: 'port', default: 5432 } } },
    NAME: { type: 'string' },
  }), {
    $schema: draft,
    type: 'object',
    properties: {
      DB: {
        type: 'object',
        properties: {
          HOST: types.host,
          PORT: { type: 'integer', minimum: 0, maximum: 65535, default: 5432 },
        },
        required: ['HOST'],
      },
      NAME: { type: 'string' },
    },
  });
  // A group with no required inner rules has no nested `required`, and the
  // group key itself never lands in the top-level `required` list.
  assert.deepStrictEqual(toJsonSchema({
    CACHE: { prefix: 'CACHE_', schema: { TTL: { type: 'duration', min: 0, max: 60, choices: [5, 30] } } },
  }), {
    $schema: draft,
    type: 'object',
    properties: {
      CACHE: {
        type: 'object',
        properties: { TTL: { type: 'number', minimum: 0, maximum: 60, enum: [5, 30] } },
      },
    },
  });
  // Flat schemas are unchanged by the group handling above.
  assert.deepStrictEqual(toJsonSchema({ PORT: { type: 'port', required: true }, NAME: { type: 'string' } }), {
    $schema: draft,
    type: 'object',
    properties: { PORT: { type: 'integer', minimum: 0, maximum: 65535 }, NAME: { type: 'string' } },
    required: ['PORT'],
  });
}

// v0.1.0 core
const env = validateEnv({
  PORT: { type: 'port', required: true },
  DEBUG: { type: 'boolean', default: false },
  API_URL: { type: 'url', required: true },
}, { PORT: '3000', DEBUG: 'false', API_URL: 'https://example.com' });
assert.strictEqual(env.PORT + 1, 3001);
assert.strictEqual(env.DEBUG, false);
assert.throws(() => validateEnv({ A: { required: true } }, {}), EnvSaafError);

// Issue #57: a file rule validates readability and preserves the path string.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(__dirname, 'file-type-test-'));
  const schema = { CONFIG_FILE: { type: 'file', required: true } };
  const file = path.join(dir, 'my config.json');
  function assertInvalid(input) {
    assert.throws(
      () => validateEnv(schema, { CONFIG_FILE: input }),
      err => err instanceof EnvSaafError && err.errors[0].includes('expected a readable file')
        && err.errors[0].includes(input),
    );
  }
  try {
    fs.writeFileSync(file, '{}');
    assert.strictEqual(validateEnv(schema, { CONFIG_FILE: file }).CONFIG_FILE, file);
    assert.strictEqual(validateEnv(schema, { CONFIG_FILE: ` ${file} ` }).CONFIG_FILE, file);
    const relative = path.relative(process.cwd(), file);
    assert.strictEqual(validateEnv(schema, { CONFIG_FILE: relative }).CONFIG_FILE, relative);
    const defaults = { CONFIG_FILE: { type: 'file', default: file } };
    assert.strictEqual(validateEnv(defaults, {}).CONFIG_FILE, file);
    assertInvalid(path.join(dir, 'missing.json'));
    assertInvalid(dir);
    assert.match(generateExample(schema), /^CONFIG_FILE=\.\/config\.json$/m);
    if (process.platform !== 'win32' && process.getuid() !== 0) {
      fs.chmodSync(file, 0o000);
      assertInvalid(file);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Port zero requests an ephemeral listener. Blank values still fail validation.
{
  const schema = { PORT: { type: 'port', required: true } };
  assert.strictEqual(validateEnv(schema, { PORT: '0' }).PORT, 0);
  assert.strictEqual(validateEnv(schema, { PORT: '65535' }).PORT, 65535);
  for (const raw of ['-1', '65536', '3.5', 'abc', ' \t ', false]) {
    assert.throws(() => validateEnv(schema, { PORT: raw }), /expected a port \(0-65535, e\.g\. 3000\)/);
  }
  // Issue #276: `null` counts as "not set", not as the string "null".
  assert.throws(() => validateEnv(schema, { PORT: null }), /missing required variable/);
  const untrimmed = { PORT: { ...schema.PORT, trim: false } };
  assert.throws(() => validateEnv(untrimmed, { PORT: ' \t ' }), /expected a port \(0-65535, e\.g\. 3000\)/);
  assert.throws(() => validateEnv(schema, { PORT: '' }), /missing required variable/);
}

// v0.2.0
assert.deepStrictEqual(parseEnvFile('PORT=3000\nNAME="my app"\n'), { PORT: '3000', NAME: 'my app' });
assert.deepStrictEqual(scanCode('process.env.API_URL; const { PORT } = process.env;'), ['API_URL', 'PORT']);
assert.deepStrictEqual(diffEnv(['A', 'B'], ['A', 'C']), { usedNotDocumented: ['B'], documentedNotUsed: ['C'] });

// Issue #221: assignment-shaped lines with invalid keys must not disappear.
{
  const secret = 'do-not-echo-this-value';
  for (const key of ['app.name', 'MY-KEY', 'MY KEY', '9NAME', '', '?', '??']) {
    assert.throws(
      () => parseEnvFile(`${key}=${secret}`),
      err => err instanceof SyntaxError && err.message === 'line 1: expected KEY=VALUE',
    );
    for (const newline of ['\n', '\r\n']) {
      for (const prefix of ['', 'export ', 'export\t']) {
        const input = ['# comment with KEY=VALUE', '', 'CERT="one', 'two"',
          ` ${prefix}${key}=${secret} # trailing`, 'PLAIN=1'].join(newline);
        assert.throws(
          () => parseEnvFile(input),
          err => err instanceof SyntaxError && err.message === 'line 5: expected KEY=VALUE'
            && !err.message.includes(secret),
        );
      }
    }
  }
  // Invalid-looking assignments inside comments and quoted values are data.
  for (const newline of ['\n', '\r\n']) {
    const input = ['# app.name=ignored', '\t# MY-KEY=ignored', '',
      'export _NAME9 = "a=b # literal" # MY KEY=ignored',
      "SINGLE='MY KEY=literal'", 'MULTI="first', 'app.name=literal',
      'MY-KEY=literal', 'MY KEY=literal', 'last" # ignored=comment',
      'PLAIN=1 # app.name=ignored', 'EMPTY= # MY-KEY=ignored'].join(newline);
    assert.deepStrictEqual(parseEnvFile(input), {
      _NAME9: 'a=b # literal', SINGLE: 'MY KEY=literal',
      MULTI: 'first\napp.name=literal\nMY-KEY=literal\nMY KEY=literal\nlast',
      PLAIN: '1', EMPTY: '',
    });
  }
}

// Issue #69: deterministic combinations of the documented .env syntax.
{
  let seed = 0x62a47f21;
  const pick = (choices) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return choices[Math.floor(seed / 0x100000000 * choices.length)];
  };
  const spaces = ['', ' ', '  ', '\t'];
  const fragments = ['sample', '42', 'x=y', 'with#hash', 'café', 'path\\part'];
  // Malformed assignments are errors (#221); only use them as comments here.
  const noise = ['', '# comment', '# ? = value', "UNCLOSED='", '# ??='];

  for (let sample = 0; sample < 128; sample++) {
    const newline = pick(['\n', '\r\n']);
    const anchor = 'FUZZ_BASE_' + sample;
    const local = 'demo' + sample;
    const reference = '${' + anchor + '}';
    const expected = { [anchor]: local };
    const lines = [anchor + '=' + local];

    for (let index = 0; index < 8; index++) {
      const key = pick(['FUZZ_KEY_', '_FUZZ_', 'Case_']) + sample + '_' + index;
      const word = pick(fragments) + '-' + pick(fragments);
      const phrase = ' ' + word + ' # literal ';
      const [encoded, value] = pick([
        [word, word],
        ['"' + phrase + '"', phrase],
        ["'" + phrase + "'", phrase],
        ['"' + word + newline + 'next line"', word + '\nnext line'],
        [reference + '/suffix', local + '/suffix'],
        ['"' + reference + ' ' + word + '"', local + ' ' + word],
        ['\\' + reference, reference],
        ["'" + reference + "'", reference],
        ['', ''],
      ]);
      const prefix = pick(['', 'export ', 'export\t']);
      const comment = pick(['', ' # trailing', '\t# trailing']);
      lines.push(pick(spaces) + prefix + key + pick(spaces) + '=' + pick(spaces) + encoded + comment);
      expected[key] = value;
    }

    const valid = lines.join(newline) + newline;
    let parsed;
    assert.doesNotThrow(() => { parsed = parseEnvFile(valid); }, JSON.stringify(valid));
    assert.deepStrictEqual(parsed, expected, JSON.stringify(valid));

    const pickDistinctNoise = (position) => pick(noise).replace('UNCLOSED', 'UNCLOSED_' + position);
    const mixed = [
      pickDistinctNoise('START'), ...lines.slice(0, 5),
      pickDistinctNoise('MIDDLE'), ...lines.slice(5), pickDistinctNoise('END'),
    ].join(newline);
    assert.doesNotThrow(() => parseEnvFile(mixed), JSON.stringify(mixed));
  }
}

// v1.0.0: masking — a real secret is never printed in full
assert.strictEqual(maskValue('sk_live_123456'), 'sk***56');
assert.strictEqual(maskValue('abc'), '****');
assert.deepStrictEqual(maskSecrets({ KEY: 'sk_live_123456' }), { KEY: 'sk***56' });
// an empty value has nothing to hide — it stays empty instead of looking set
assert.strictEqual(maskValue(''), '');
assert.strictEqual(maskValue('x'), '****');
assert.deepStrictEqual(maskSecrets({ KEY: '' }), { KEY: '' });
// v1.0.0: generateExample — placeholders/defaults only, never a real secret
const ex = generateExample({ PORT: { type: 'port', required: true }, API_KEY: { type: 'string', required: true } });
assert.ok(ex.includes('PORT=3000'));
assert.ok(ex.includes('API_KEY=\n'));
assert.ok(!ex.includes('sk_live'));

// Issue #56: secret-looking keys get an empty placeholder in the generated example.
{
  const { generateExample } = require('./index');
  const ex2 = generateExample({
    API_KEY: { type: 'string', required: true },
    DB_PASSWORD: { type: 'string' },
    MONKEY: { type: 'string' },
    PORT: { type: 'port' },
    TOKEN_WITH_DEFAULT: { type: 'string', default: 'abc' },
  });
  assert.ok(ex2.includes('API_KEY=\n'));
  assert.ok(ex2.includes('DB_PASSWORD=\n'));
  // 'KEY' inside another word does not count as a secret-looking key.
  assert.ok(ex2.includes('MONKEY=your_value_here'));
  assert.ok(ex2.includes('PORT=3000'));
  // An explicit default wins over the secret rule.
  assert.ok(ex2.includes('TOKEN_WITH_DEFAULT=abc'));
}

// Issue #206: generateExample annotates aliases and requiredIf in comments.
{
  const { generateExample } = require('./index');
  const ex3 = generateExample({
    DB_URL: { type: 'url', required: true, aliases: ['DATABASE_URL'] },
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
    FEATURE_X: { type: 'string', requiredIf: { key: 'MODE', in: ['staging', 'production'] } },
    MULTI: { type: 'string', aliases: ['OLD_A', 'OLD_B'] },
    PLAIN: { type: 'string' },
  });
  assert.ok(ex3.includes('# type: url, required; also accepts DATABASE_URL (deprecated)'));
  assert.ok(ex3.includes("# type: url; required when MODE is 'production'"));
  assert.ok(ex3.includes("# type: string; required when MODE is one of 'staging', 'production'"));
  assert.ok(ex3.includes('# type: string; also accepts OLD_A, OLD_B (deprecated)'));
  // Keys without these options keep the existing format.
  assert.ok(ex3.includes('# type: string\nPLAIN=your_value_here'));
}

// Issue #84: trim: false keeps leading/trailing whitespace for string-like types.
{
  const { validateEnv } = require('./index');
  assert.strictEqual(validateEnv({ T: { type: 'string', trim: false } }, { T: '  abc  ' }).T, '  abc  ');
  // Default behaviour is unchanged: values are trimmed.
  assert.strictEqual(validateEnv({ T: { type: 'string' } }, { T: '  abc  ' }).T, 'abc');
  // With trim: false a padded URL is kept exactly as provided (the URL parser itself tolerates the spaces).
  assert.strictEqual(validateEnv({ U: { type: 'url', trim: false } }, { U: ' https://example.com ' }).U, ' https://example.com ');
  assert.strictEqual(validateEnv({ U: { type: 'url', trim: false } }, { U: 'https://example.com' }).U, 'https://example.com');
  // A padded email is kept as-is, so it fails the no-whitespace rule instead of being silently fixed.
  assert.throws(() => validateEnv({ E: { type: 'email', trim: false } }, { E: ' a@example.com ' }), /expected a valid email/);
  // Numeric and boolean coercion is unaffected by trim: false.
  assert.strictEqual(validateEnv({ N: { type: 'number', trim: false } }, { N: ' 42 ' }).N, 42);
  assert.strictEqual(validateEnv({ B: { type: 'boolean', trim: false } }, { B: ' true ' }).B, true);
  // Choices and length checks see the kept whitespace.
  assert.throws(() => validateEnv({ M: { type: 'string', trim: false, choices: ['dev'] } }, { M: ' dev ' }), /expected one of/);
  assert.throws(() => validateEnv({ S: { type: 'string', trim: false, maxLength: 3 } }, { S: '  ab  ' }), /at most 3 characters/);
}

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

// Issue #235: scanDir also scans single-file components (.vue/.svelte/.astro)
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { scanDir } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-sfc-'));
  try {
    // Vue: <script> block reads. Comments and string literals inside the
    // script do not count (the same scanCode masking as for .js files).
    fs.writeFileSync(path.join(dir, 'App.vue'), [
      '<template><p>{{ title }}</p></template>',
      '<script setup>',
      "const api = process.env.VITE_API_URL;",
      "const key = import.meta.env.VITE_PUBLIC_KEY;",
      '// process.env.IN_VUE_COMMENT',
      'const doc = "process.env.IN_VUE_STRING";',
      '</script>',
      '',
    ].join('\n'));
    // Svelte: instance script reads.
    fs.writeFileSync(path.join(dir, 'Widget.svelte'), [
      '<script>let host = process.env.SVELTE_HOST;</script>',
      '<p>hello</p>',
      '',
    ].join('\n'));
    // Astro: frontmatter reads.
    fs.writeFileSync(path.join(dir, 'Page.astro'), [
      '---',
      "const db = process.env.DATABASE_URL;",
      '---',
      '<html></html>',
      '',
    ].join('\n'));
    // Nested directory: the walk is recursive.
    fs.mkdirSync(path.join(dir, 'src', 'components'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'components', 'Nested.vue'), 'export const x = process.env.NESTED_VUE;\n');
    // Skips stay intact: node_modules and .git* are never scanned.
    fs.mkdirSync(path.join(dir, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dep', 'index.js'), 'process.env.IN_NODE_MODULES;\n');
    fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'hooks', 'h.js'), 'process.env.IN_GIT;\n');
    // Non-code extensions are still ignored.
    fs.writeFileSync(path.join(dir, 'page.html'), '<script>process.env.IN_HTML;</script>\n');
    fs.writeFileSync(path.join(dir, 'styles.css'), '/* process.env.IN_CSS */\n');

    assert.deepStrictEqual(scanDir(dir), [
      'DATABASE_URL',
      'NESTED_VUE',
      'SVELTE_HOST',
      'VITE_API_URL',
      'VITE_PUBLIC_KEY',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  // Issue #158: an explicitly passed single `path` that does not exist throws
  // naming the path even when every variable is optional — a typo'd path is a
  // deliberate instruction, and ignoring it silently would boot with defaults.
  assert.throws(
    () => loadEnv({ PORT: { type: 'port', default: 3000 } }, { path: path.join(dir, 'nope.env'), env: {} }),
    (e) => e.message === `env-saaf: .env file not found: ${path.join(dir, 'nope.env')}`
  );
  // the implicit default `.env` stays optional: nothing required -> defaults
  const env4 = loadEnv({ PORT: { type: 'port', default: 3000 } }, { env: {} });
  assert.strictEqual(env4.PORT, 3000);
  // list forms keep skipping missing entries (no throw, defaults apply)
  assert.strictEqual(
    loadEnv({ PORT: { type: 'port', default: 3000 } }, { paths: [path.join(dir, 'nope.env')], env: {} }).PORT, 3000
  );
  assert.strictEqual(
    loadEnv({ PORT: { type: 'port', default: 3000 } }, { path: [path.join(dir, 'nope.env')], env: {} }).PORT, 3000
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #157: loadEnv names the path when a file exists but cannot be read —
// a directory (EISDIR) or a permission-denied file (EACCES) — instead of
// leaking the raw Node error. Missing files keep their behaviour above.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-eisdir-'));
  const schema = { PORT: { type: 'port', required: true } };
  // a directory passed as path reports the path, not a raw EISDIR
  assert.throws(
    () => loadEnv(schema, { path: dir, env: {} }),
    (e) => e.code === undefined && e.message.includes(`cannot read .env file at ${dir}`)
  );
  // the same applies to every entry of a paths: [...] list
  assert.throws(
    () => loadEnv(schema, { paths: [path.join(dir, 'nope.env'), dir], env: {} }),
    (e) => e.code === undefined && e.message.includes(`cannot read .env file at ${dir}`)
  );
  // a permission-denied file reports the path instead of a raw EACCES/EPERM
  if (process.platform !== 'win32' && process.getuid() !== 0) {
    const file = path.join(dir, '.env.sealed');
    fs.writeFileSync(file, 'PORT=4000\n');
    fs.chmodSync(file, 0o000);
    assert.throws(
      () => loadEnv(schema, { path: file, env: {} }),
      (e) => e.code === undefined && e.message.includes(`cannot read .env file at ${file}`)
    );
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #83: reject a misplaced path or other non-schema argument up front.
{
  const { loadEnv } = require('./index');
  const message = "loadEnv expects a schema object as the first argument — did you mean loadEnv(schema, { path: '.env' })?";
  assert.throws(() => loadEnv('.env', { PORT: { type: 'port' } }), { name: 'TypeError', message });
  for (const schema of [null, undefined, [], 42, false, 1n, Symbol('schema'), () => { }, new Date(), new Map(), new (class Schema { })()]) {
    assert.throws(() => loadEnv(schema), { name: 'TypeError', message });
  }
  // Argument validation must happen before reading options or files.
  assert.throws(() => loadEnv('.env', { get path() { throw new Error('options read too soon'); } }), { name: 'TypeError', message });
  assert.deepStrictEqual(loadEnv({}, { paths: [], env: {} }), {});
  const schema = Object.assign(Object.create(null), { PORT: { type: 'port' } });
  assert.strictEqual(loadEnv(schema, { paths: [], env: { PORT: '3000' } }).PORT, 3000);
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

// Issue #50: `protocols` allowlists the schemes a `url` value may use.
{
  // An allowed scheme passes, and the value comes back exactly as given.
  assert.strictEqual(
    validateEnv({ U: { type: 'url', protocols: ['https'] } }, { U: 'https://example.com' }).U,
    'https://example.com');
  // Several allowed schemes; matching is case-insensitive, with or without ':'.
  assert.strictEqual(
    validateEnv({ U: { type: 'url', protocols: ['http', 'https:'] } }, { U: 'HTTPS://example.com/x' }).U,
    'HTTPS://example.com/x');
  // A scheme outside the list is rejected, naming the allowed schemes.
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: ['https'] } }, { U: 'ftp://example.com/x' }),
    /expected a URL with one of these protocols \(https\), got "ftp:\/\/example\.com\/x"/);
  // Without the option, any valid URL still passes.
  assert.strictEqual(
    validateEnv({ U: { type: 'url' } }, { U: 'ftp://example.com/x' }).U, 'ftp://example.com/x');
  // A bad `protocols` option is rejected up front, naming the key — even
  // when the variable is absent.
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: 'https' } }, {}),
    /U: "protocols" must be a non-empty array of schemes/);
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: [] } }, {}),
    /U: "protocols" must be a non-empty array of schemes/);
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: ['ht tp'] } }, {}),
    /U: "protocols" must be a non-empty array of schemes/);
  // A default goes through the same check as a provided value.
  assert.throws(
    () => validateEnv({ U: { type: 'url', protocols: ['https'], default: 'ftp://example.com' } }, {}),
    /one of these protocols/);
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

// Issue #160: a template parse error must print the `env-saaf: ` prefix
// exactly once — parseEnvFile's duplicate-key error already carries it,
// and readEnvFile used to add it again (in text and --json output).
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-dbl-prefix-'));
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.PORT;');
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=3000\nPORT=3001\n');
    const human = run(['check', dir]);
    assert.strictEqual(human.status, 2);
    assert.strictEqual(human.stderr.trim(), 'env-saaf: .env.example: duplicate key PORT at line 2 (first defined at line 1)');
    assert.ok(!human.stderr.includes('env-saaf: .env.example: env-saaf:'));
    const json = run(['check', dir, '--json']);
    assert.strictEqual(json.status, 2);
    assert.strictEqual(JSON.parse(json.stdout).error, '.env.example: duplicate key PORT at line 2 (first defined at line 1)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #113: 'check' exits 1 whenever it reports a finding — including EXTRA /
// MISSING keys in .env, which used to print a line and still exit 0 — and
// --json 'ok' matches the exit code in every case. A clean project still exits 0.
// Decision: UNUSED (documented but never referenced in code) is a finding too.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-check-'));
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  const write = (name, text) => fs.writeFileSync(path.join(dir, name), text);

  write('app.js', 'const flag = process.env.KNOWN;');
  write('.env.example', 'KNOWN=1\n');

  // Clean project: exit 0, ok true.
  write('.env', 'KNOWN=1\n');
  const clean = run(['check', dir]);
  assert.strictEqual(clean.status, 0);
  assert.strictEqual(JSON.parse(run(['check', dir, '--json']).stdout.trim()).ok, true);

  // The only finding is EXTRA in .env: exit 1, and --json agrees.
  write('.env', 'KNOWN=1\nTYPO_KEY=2\n');
  const extra = run(['check', dir]);
  assert.strictEqual(extra.status, 1);
  assert.ok(extra.stdout.includes('EXTRA in .env: TYPO_KEY'));
  const extraJson = JSON.parse(run(['check', dir, '--json']).stdout.trim());
  assert.strictEqual(extraJson.ok, false);
  assert.deepStrictEqual(extraJson.envExtra, ['TYPO_KEY']);
  assert.strictEqual(run(['check', dir, '--json']).status, 1);

  // The only finding is MISSING in .env: exit 1.
  write('.env', '');
  const missing = run(['check', dir]);
  assert.strictEqual(missing.status, 1);
  assert.ok(missing.stdout.includes('MISSING in .env: KNOWN'));

  // UNUSED (documented, never used in code): exit 1 as well.
  write('.env.example', 'KNOWN=1\nUNUSED_KEY=2\n');
  write('.env', 'KNOWN=1\nUNUSED_KEY=2\n');
  const unused = run(['check', dir]);
  assert.strictEqual(unused.status, 1);
  assert.ok(unused.stdout.includes('UNUSED: UNUSED_KEY'));

  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #102: CLI 'example --write' — save the draft to a file instead of printing it
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MY_FLAG;');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  // without --write: draft still goes to stdout and no file is created
  const plain = run(['example', dir]);
  assert.strictEqual(plain.status, 0);
  assert.ok(plain.stdout.includes('MY_FLAG='));
  assert.ok(!fs.existsSync(path.join(dir, '.env.example')));
  // --write: draft lands in .env.example, with a confirmation on stdout
  const wrote = run(['example', dir, '--write']);
  assert.strictEqual(wrote.status, 0);
  assert.ok(wrote.stdout.includes('wrote .env.example'));
  const saved = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
  assert.ok(saved.includes('MY_FLAG='));
  // --write again without --force: refuses, exit 1, file untouched
  const again = run(['example', dir, '--write']);
  assert.strictEqual(again.status, 1);
  assert.ok(again.stderr.includes('--force'));
  assert.strictEqual(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), saved);
  // --write --force: overwrites with a fresh scan
  fs.writeFileSync(path.join(dir, 'app.js'), 'const x = process.env.MY_FLAG; const y = process.env.OTHER;');
  const forced = run(['example', dir, '--write', '--force']);
  assert.strictEqual(forced.status, 0);
  assert.ok(fs.readFileSync(path.join(dir, '.env.example'), 'utf8').includes('OTHER='));
  // --write=<file>: writes to the named file instead
  const named = run(['example', dir, '--write=.env.local.example']);
  assert.strictEqual(named.status, 0);
  assert.ok(fs.readFileSync(path.join(dir, '.env.local.example'), 'utf8').includes('MY_FLAG='));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #116: 'example --write' on a directory with no variables refuses
// instead of writing a header-only file. Plain 'example' (stdout) is unchanged.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("nothing to see here");');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  // --write: warns on stderr, exits 1, and writes no file
  const refused = run(['example', dir, '--write']);
  assert.strictEqual(refused.status, 1);
  assert.ok(refused.stderr.includes('no process.env usage found'), refused.stderr);
  assert.ok(!fs.existsSync(path.join(dir, '.env.example')));
  // plain example on the same directory is unchanged: exit 0, header only
  const plain = run(['example', dir]);
  assert.strictEqual(plain.status, 0);
  assert.ok(plain.stdout.includes('# Generated by env-saaf'));
  assert.ok(!fs.existsSync(path.join(dir, '.env.example')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #206: 'example --schema <file>' generates from the schema, so the
// alias/requiredIf annotations show in CLI output too. Without --schema the
// scan draft is unchanged (see above).
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cli-'));
  fs.writeFileSync(path.join(dir, 'env.schema.js'),
    "module.exports = {\n"
    + "  DB_URL: { type: 'url', required: true, aliases: ['DATABASE_URL'] },\n"
    + "  SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },\n"
    + "};\n");
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });
  const out = run(['example', dir, '--schema', 'env.schema.js']);
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes('# type: url, required; also accepts DATABASE_URL (deprecated)'), out.stdout);
  assert.ok(out.stdout.includes("# type: url; required when MODE is 'production'"), out.stdout);
  assert.ok(out.stdout.includes('DB_URL=https://example.com'), out.stdout);
  // --write saves the same annotated text, and refuses to overwrite without --force.
  const wrote = run(['example', dir, '--schema', 'env.schema.js', '--write']);
  assert.strictEqual(wrote.status, 0, wrote.stderr);
  assert.ok(fs.readFileSync(path.join(dir, '.env.example'), 'utf8').includes('also accepts DATABASE_URL (deprecated)'));
  const again = run(['example', dir, '--schema', 'env.schema.js', '--write']);
  assert.strictEqual(again.status, 1);
  assert.ok(again.stderr.includes('--force'));
  // A missing schema file fails with exit 2 and names the file.
  const missing = run(['example', dir, '--schema', 'nope.js']);
  assert.strictEqual(missing.status, 2);
  assert.ok(missing.stderr.includes('cannot load schema nope.js'), missing.stderr);
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

// Issue #225: scanCode — Vite-style import.meta.env reads (dot, bracket, destructuring)
{
  assert.deepStrictEqual(scanCode('const k = import.meta.env.VITE_API_KEY;'), ['VITE_API_KEY']);
  assert.deepStrictEqual(
    scanCode("const a = import.meta.env['VITE_A']; const b = import.meta.env[`VITE_B`];"),
    ['VITE_A', 'VITE_B']
  );
  assert.deepStrictEqual(
    scanCode('const { VITE_MODE, VITE_NAME: name } = import.meta.env;'),
    ['VITE_MODE', 'VITE_NAME']
  );
  // Mixed with process.env reads in one source: one sorted, unique list.
  assert.deepStrictEqual(
    scanCode('import.meta.env.VITE_API_KEY; process.env.PORT; import.meta.env.VITE_API_KEY;'),
    ['PORT', 'VITE_API_KEY']
  );
  // Mentions inside comments and string literals are not reads.
  assert.deepStrictEqual(
    scanCode('// set import.meta.env.VITE_NOPE first\nconst s = "import.meta.env.VITE_ALSO_NOPE";'),
    []
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

// Issue #97: --help / -h recognised after a subcommand, not treated as a directory
{
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  for (const args of [
    ['scan', '--help'],
    ['check', '--help'],
    ['example', '--help'],
    ['scan', '-h'],
    ['scan', '--help', 'some-dir'],
  ]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, args.join(' ') + ' should exit 0: ' + run.stderr);
    assert.ok(run.stdout.includes('Usage: env-saaf'), args.join(' ') + ' should print usage');
    assert.ok(!/ENOENT|not found/.test(run.stderr + run.stdout), args.join(' ') + ' must not treat --help as a path');
  }
}

// Issue #62: --no-color is accepted globally and the CLI keeps its output plain.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-plain-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const value = process.env.PLAIN_OUTPUT;');
    const commands = [
      { args: ['--no-color', 'scan', dir] },
      { args: ['scan', '--no-color', dir] },
      { args: ['scan', dir, '--no-color'] },
      { args: ['scan', dir], env: { ...process.env, NO_COLOR: '1' } },
    ];
    for (const { args, env } of commands) {
      const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
      assert.strictEqual(run.status, 0, args.join(' '));
      assert.strictEqual(run.stdout.trim(), 'PLAIN_OUTPUT');
      assert.strictEqual(run.stderr, '');
    }

    const json = spawnSync(process.execPath, [cli, 'scan', '--no-color', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 0);
    assert.deepStrictEqual(JSON.parse(json.stdout), { ok: true, vars: ['PLAIN_OUTPUT'] });

    const help = spawnSync(process.execPath, [cli, '--no-color', '--help'], { encoding: 'utf8' });
    assert.strictEqual(help.status, 0);
    assert.ok(help.stdout.includes('--no-color'));
    assert.strictEqual(help.stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #98: global --version / -v flag — print the installed version and exit 0.
{
  const { spawnSync } = require('node:child_process');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const expected = `env-saaf ${require('./package.json').version}\n`;

  const commands = [
    ['--version'],
    ['-v'],
    ['check', '--version'],
    ['scan', '-v'],
    ['--no-color', '--version'],
  ];
  for (const args of commands) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.strictEqual(run.status, 0, args.join(' '));
    assert.strictEqual(run.stdout, expected, args.join(' '));
    assert.strictEqual(run.stderr, '', args.join(' '));
  }

  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.ok(help.stdout.includes('--version'));
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
  // Issue #187: the same keys are also exposed as `unused`, the name scan --json uses
  assert.deepStrictEqual(parsed.unused, ['EXTRA_KEY']);

  // scan --json: lists vars, ok true, exit 0
  const scanOut = execFileSync('node', [cli, 'scan', dir, '--json'], { encoding: 'utf8' });
  const scanParsed = JSON.parse(scanOut);
  assert.strictEqual(scanParsed.ok, true);
  assert.deepStrictEqual(scanParsed.vars.sort(), ['MISSING_KEY', 'OK_KEY']);

  // human output still default (no --json)
  const humanOut = execFileSync('node', [cli, 'scan', dir], { encoding: 'utf8', stdio: 'pipe' });
  assert.ok(humanOut.includes('MISSING_KEY'));
  assert.ok(!humanOut.includes('{'));

  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #187: check --json exposes documented-but-unused keys as `unused`, the
// same name scan --json uses for them — `extra` keeps the same list so existing
// consumers of the old shape are untouched.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-check-unused-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const used = process.env.USED_KEY;');
    fs.writeFileSync(path.join(dir, '.env.example'), 'USED_KEY=1\nOLD_KEY=2\nANOTHER_OLD=3\n');

    const json = spawnSync(process.execPath, [cli, 'check', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 1);
    const parsed = JSON.parse(json.stdout);
    assert.strictEqual(parsed.ok, false);
    assert.deepStrictEqual(parsed.extra, ['OLD_KEY', 'ANOTHER_OLD']);
    assert.deepStrictEqual(parsed.unused, ['OLD_KEY', 'ANOTHER_OLD']);
    assert.deepStrictEqual(parsed.missing, []);

    // Text mode is unchanged: UNUSED stays a finding with exit 1.
    const human = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.strictEqual(human.status, 1);
    assert.ok(human.stdout.includes('UNUSED: OLD_KEY'), human.stdout);
    assert.ok(human.stdout.includes('UNUSED: ANOTHER_OLD'), human.stdout);

    // scan --json is untouched: `unused` still sits next to `vars`, ok true, exit 0.
    const scanJson = spawnSync(process.execPath, [cli, 'scan', dir, '--json'], { encoding: 'utf8' });
    assert.strictEqual(scanJson.status, 0);
    assert.deepStrictEqual(JSON.parse(scanJson.stdout), {
      ok: true,
      vars: ['USED_KEY'],
      unused: ['OLD_KEY', 'ANOTHER_OLD'],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #100: CLI check also compares the real .env with the template keys.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-envkeys-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const db = process.env.DATABASE_URL;');
    fs.writeFileSync(path.join(dir, '.env.example'), 'DATABASE_URL=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'DATABSE_URL=postgres://localhost/app\n');

    const human = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.ok(human.stdout.includes('EXTRA in .env: DATABSE_URL (not in .env.example)'), human.stdout);
    assert.ok(human.stdout.includes('MISSING in .env: DATABASE_URL (in .env.example, not set locally)'), human.stdout);

    const json = spawnSync(process.execPath, [cli, 'check', dir, '--json'], { encoding: 'utf8' });
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      ok: false,
      missing: [],
      extra: [],
      unused: [],
      invalid: [],
      envExtra: ['DATABSE_URL'],
      envMissing: ['DATABASE_URL'],
    });

    // A matching .env is clean; the existing all-clean message still applies.
    fs.writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgres://localhost/app\n');
    const clean = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.strictEqual(clean.status, 0);
    assert.ok(clean.stdout.includes('all clean'));
    assert.ok(!clean.stdout.includes('in .env:'));

    // Without .env the comparison is skipped and the old shape is unchanged except for empty fields.
    fs.rmSync(path.join(dir, '.env'));
    const noEnv = spawnSync(process.execPath, [cli, 'check', dir, '--json'], { encoding: 'utf8' });
    assert.deepStrictEqual(JSON.parse(noEnv.stdout), {
      ok: true,
      missing: [],
      extra: [],
      unused: [],
      invalid: [],
      envExtra: [],
      envMissing: [],
    });

    // --file selects the template used for the comparison too.
    fs.writeFileSync(path.join(dir, '.env.sample'), 'SAMPLE_KEY=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'SAMPLE_KEY=set\nTYPO_KEY=oops\n');
    const custom = spawnSync(process.execPath, [cli, 'check', dir, '--file', '.env.sample', '--json'], { encoding: 'utf8' });
    assert.deepStrictEqual(JSON.parse(custom.stdout).envExtra, ['TYPO_KEY']);
    assert.deepStrictEqual(JSON.parse(custom.stdout).envMissing, []);
    assert.deepStrictEqual(JSON.parse(custom.stdout).missing, ['DATABASE_URL']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #70: CLI scan finds literal env reads in TypeScript modules.
{
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-ts-cli-'));

  try {
    fs.writeFileSync(path.join(dir, 'service.ts'), [
      "enum Mode { Hosted = 'hosted' }",
      "export const hosts = { [Mode.Hosted]: process.env['SERVICE_HOST'] } as const;",
    ].join('\n'));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'server.mts'), [
      'export namespace Server {',
      '  const { API_PORT: port } = process.env;',
      '  export const config = { port, endpoint: process.env.SERVICE_HOST } as const;',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'worker.cts'), [
      "const { QUEUE_NAME = 'default' } = process.env;",
      'export const config = { queue: QUEUE_NAME, tracing: process.env["TRACE_MODE"] } as const;',
    ].join('\n'));
    const output = execFileSync(process.execPath, [path.join(__dirname, 'cli.js'), 'scan', dir, '--json'], {
      encoding: 'utf8',
    });
    assert.deepStrictEqual(JSON.parse(output), {
      ok: true,
      vars: ['API_PORT', 'QUEUE_NAME', 'SERVICE_HOST', 'TRACE_MODE'],
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #30: parseEnvFile — multiline quoted values keep their newlines
// (PEM keys, JSON blobs); the key after the closing quote still parses.
assert.deepStrictEqual(
  parseEnvFile('KEY="-----BEGIN-----\nabc123\n-----END-----"\nNEXT=ok\n'),
  { KEY: '-----BEGIN-----\nabc123\n-----END-----', NEXT: 'ok' });
assert.deepStrictEqual(
  parseEnvFile("KEY='line1\nline2' # trailing\nNEXT=ok\n"),
  { KEY: 'line1\nline2', NEXT: 'ok' });

// Issue #22: parseEnvFile — ${VAR} interpolation in double-quoted and
// unquoted values; the file's own values win over process.env; nested
// references expand; single-quoted and \${...} escapes stay literal;
// unknown names expand to an empty string.
assert.deepStrictEqual(
  parseEnvFile('HOST=example.com\nURL=https://${HOST}/api\n'),
  { HOST: 'example.com', URL: 'https://example.com/api' });
assert.deepStrictEqual(
  parseEnvFile('A=hello\nB=${A} world\nC=${B}!\n'),
  { A: 'hello', B: 'hello world', C: 'hello world!' });
assert.deepStrictEqual(
  parseEnvFile("A=hello\nB='${A}'\n"),
  { A: 'hello', B: '${A}' });
assert.deepStrictEqual(
  parseEnvFile('A=hello\nB=\\${A}\n'),
  { A: 'hello', B: '${A}' });
assert.deepStrictEqual(
  parseEnvFile('B=x${MISSING_VAR}y\n'),
  { B: 'xy' });

// Issue #136: unset and empty values have different defaults.
{
  const missing = 'ENV_SAAF_TEST_MISSING_DEFAULT';
  const external = 'ENV_SAAF_TEST_PROCESS_DEFAULT';
  const priorMissing = process.env[missing];
  const priorExternal = process.env[external];
  try {
    delete process.env[missing];
    process.env[external] = 'process-value';
    const values = parseEnvFile([
      'SET=value',
      'EMPTY=',
      'ALIAS=${ENV_SAAF_TEST_MISSING_DEFAULT}',
      'UNSET_COLON=${ENV_SAAF_TEST_MISSING_DEFAULT:-fallback}',
      'UNSET_DASH=${ENV_SAAF_TEST_MISSING_DEFAULT-fallback}',
      'SET_COLON="${SET:-ignored}"',
      'SET_DASH=${SET-ignored}',
      'EMPTY_COLON=${EMPTY:-fallback}',
      'EMPTY_DASH=${EMPTY-ignored}',
      'EXPANDED_EMPTY=${ALIAS:-fallback}',
      'EMPTY_DEFAULT=x${ENV_SAAF_TEST_MISSING_DEFAULT:-}y',
      'PROCESS=${ENV_SAAF_TEST_PROCESS_DEFAULT:-fallback}',
      'NESTED=${ENV_SAAF_TEST_MISSING_DEFAULT:-${SET}}',
      'UNUSED_NESTED=${SET:-${ENV_SAAF_TEST_MISSING_DEFAULT:-ignored}}',
      'ESCAPED=\\${SET:-ignored}',
      'NESTED_ESCAPED=${ENV_SAAF_TEST_MISSING_DEFAULT:-\\${SET}}',
      "SINGLE='${SET:-ignored}'",
      'UNTERMINATED=${SET} ${SET:-fallback',
    ].join('\n'));
    assert.deepStrictEqual(values, {
      SET: 'value',
      EMPTY: '',
      ALIAS: '',
      UNSET_COLON: 'fallback',
      UNSET_DASH: 'fallback',
      SET_COLON: 'value',
      SET_DASH: 'value',
      EMPTY_COLON: 'fallback',
      EMPTY_DASH: '',
      EXPANDED_EMPTY: 'fallback',
      EMPTY_DEFAULT: 'xy',
      PROCESS: 'process-value',
      NESTED: 'value',
      UNUSED_NESTED: 'value',
      ESCAPED: '${SET:-ignored}',
      NESTED_ESCAPED: '${SET}',
      SINGLE: '${SET:-ignored}',
      UNTERMINATED: 'value ${SET:-fallback',
    });
  } finally {
    if (priorMissing === undefined) delete process.env[missing];
    else process.env[missing] = priorMissing;
    if (priorExternal === undefined) delete process.env[external];
    else process.env[external] = priorExternal;
  }
}

// Issue #185: a self-reference with a default (`${A:-...}` / `${A-...}`) uses
// the default, because the key's own value is not set while its own line is
// being resolved — exactly as for a genuinely absent name. A self-reference
// without a default stays literal, and a genuine cycle (A=${B}, B=${A}) still
// resolves to literals without looping forever.
assert.deepStrictEqual(
  parseEnvFile('A=${A:-fallback}\n'),
  { A: 'fallback' });
assert.deepStrictEqual(
  parseEnvFile('A=${A-fallback}\n'),
  { A: 'fallback' });
assert.deepStrictEqual(
  parseEnvFile('A=${A}\n'),
  { A: '${A}' });
assert.deepStrictEqual(
  parseEnvFile('A=${B}\nB=${A}\n'),
  { A: '${A}', B: '${B}' });
// the self-reference is unset at nesting depth too: it sits inside another
// key's default, reached while A's own line is being resolved
assert.deepStrictEqual(
  parseEnvFile('A=${ENV_SAAF_TEST_MISSING_NESTED:-${A:-q}}\n'),
  { A: 'q' });

// Issue #25: loadEnv — multiple files; later files override earlier ones,
// via `paths: [...]` or `path` as an array.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-multi-'));
  const f1 = path.join(dir, '.env');
  const f2 = path.join(dir, '.env.local');
  fs.writeFileSync(f1, 'PORT=3000\nHOST=base\n');
  fs.writeFileSync(f2, 'HOST=local\n');
  const merged = loadEnv(
    { PORT: { type: 'port', required: true }, HOST: { type: 'string', required: true } },
    { paths: [f1, f2], env: {} });
  assert.strictEqual(merged.PORT, 3000);
  assert.strictEqual(merged.HOST, 'local');
  const viaArray = loadEnv({ HOST: { type: 'string' } }, { path: [f1, f2], env: {} });
  assert.strictEqual(viaArray.HOST, 'local');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #34: per-key 'transform' — custom parsing after coercion
{
  const { validateEnv, loadEnv } = require('./index');
  // the issue's own examples: split a comma list, normalise case
  const t1 = validateEnv({
    ALLOWED_ORIGINS: { type: 'array', transform: xs => xs.map(s => s.toLowerCase()) },
    SHOUTY_NAME: { type: 'string', transform: v => v.toUpperCase() },
  }, { ALLOWED_ORIGINS: 'A.COM, B.COM ,c.com', SHOUTY_NAME: 'hello' });
  assert.deepStrictEqual(t1.ALLOWED_ORIGINS, ['a.com', 'b.com', 'c.com']);
  assert.strictEqual(t1.SHOUTY_NAME, 'HELLO');
  // transform runs AFTER coercion and the choices check: a port arrives as a number
  const t2 = validateEnv({ PORT_PLUS: { type: 'port', transform: n => n + 1 } }, { PORT_PLUS: '3000' });
  assert.strictEqual(t2.PORT_PLUS, 3001);
  // a choices failure skips the transform entirely
  let transformCalled = false;
  assert.throws(
    () => validateEnv(
      { MODE: { type: 'string', choices: ['a', 'b'], transform: v => { transformCalled = true; return v; } } },
      { MODE: 'c' }
    ),
    /expected one of/
  );
  assert.strictEqual(transformCalled, false);
  // a throwing transform is collected as a normal validation error, naming the key —
  // and it does not hide the other keys' errors
  assert.throws(
    () => validateEnv({
      BAD: { type: 'string', transform: () => { throw new Error('nope'); } },
      MISSING: { type: 'string', required: true },
    }, { BAD: 'x' }),
    (e) => e instanceof EnvSaafError
      && e.errors.length === 2
      && e.errors.some(m => m.includes('BAD: transform failed: nope'))
      && e.errors.some(m => m.includes('MISSING: missing'))
  );
  // transform does NOT run on defaults — a default passes through untouched
  let defaultTransformed = false;
  const t3 = validateEnv(
    { GREETING: { type: 'string', default: 'hi', transform: v => { defaultTransformed = true; return v + '!'; } } },
    {}
  );
  assert.strictEqual(t3.GREETING, 'hi');
  assert.strictEqual(defaultTransformed, false);
  // a non-function transform is a schema error naming the key
  assert.throws(
    () => validateEnv({ A: { type: 'string', transform: 'split' } }, { A: 'x' }),
    /A: "transform" must be a function/
  );
  // end-to-end: loadEnv applies transforms too (it validates through validateEnv)
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-transform-'));
  fs.writeFileSync(path.join(dir, '.env'), 'ALLOWED_ORIGINS=A.COM, B.COM\n');
  const loaded = loadEnv(
    { ALLOWED_ORIGINS: { type: 'array', required: true, transform: xs => xs.map(s => s.toLowerCase()) } },
    { path: path.join(dir, '.env'), env: {} }
  );
  assert.deepStrictEqual(loaded.ALLOWED_ORIGINS, ['a.com', 'b.com']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #23: 'email' type and 'pattern' option for strings
{
  const { validateEnv } = require('./index');
  // email: pragmatic validation — one '@', non-empty local/domain, a dot in the domain
  assert.strictEqual(validateEnv({ E: { type: 'email' } }, { E: 'a@b.co' }).E, 'a@b.co');
  assert.strictEqual(validateEnv({ E: { type: 'email' } }, { E: 'first.last+tag@sub.example.org' }).E, 'first.last+tag@sub.example.org');
  for (const bad of ['not-an-email', 'a@b', '@b.co', 'a@.co', 'a@b.', 'a@@b.co', 'a b@c.co', 'a@c']) {
    assert.throws(() => validateEnv({ E: { type: 'email' } }, { E: bad }), /expected a valid email address/);
  }
  // pattern: a slug and a prefixed key; the mismatch error names the pattern
  const p = validateEnv({
    SLUG: { type: 'string', pattern: /^[a-z0-9-]+$/ },
    API_KEY: { type: 'string', pattern: /^sk_[A-Za-z0-9]+$/ },
  }, { SLUG: 'my-post-2', API_KEY: 'sk_abc123' });
  assert.strictEqual(p.SLUG, 'my-post-2');
  assert.strictEqual(p.API_KEY, 'sk_abc123');
  assert.throws(
    () => validateEnv({ S: { type: 'string', pattern: /^[a-z0-9-]+$/ } }, { S: 'Bad Slug!' }),
    (e) => e instanceof EnvSaafError && e.errors.some(m => m.includes('S: expected to match /^[a-z0-9-]+$/'))
  );
  // pattern also works with the email type, and runs after the choices check
  assert.strictEqual(
    validateEnv({ E: { type: 'email', pattern: /@example\.com$/ } }, { E: 'a@example.com' }).E, 'a@example.com');
  assert.throws(
    () => validateEnv({ E: { type: 'email', pattern: /@example\.com$/ } }, { E: 'a@other.com' }),
    /expected to match/
  );
  // a non-RegExp pattern is a schema error naming the key
  assert.throws(
    () => validateEnv({ S: { type: 'string', pattern: '[a-z]+' } }, { S: 'abc' }),
    /S: "pattern" must be a RegExp/
  );
}

// Issue #33: scanCode finds process.env[`KEY`] template-literal access,
// but not interpolated names — those cannot be known statically.
assert.deepStrictEqual(
  scanCode('const v = process.env[`DYNAMIC_NAME`]; const w = process.env[`PREFIX_${SUFFIX}`];'),
  ['DYNAMIC_NAME']);
assert.deepStrictEqual(
  scanCode('process.env.API_URL; process.env[\'BRACKET\']; process.env[`TICK`];'),
  ['API_URL', 'BRACKET', 'TICK']);


// Issues #45 + #47: 'int' type (whole numbers only) and min/max for numbers.
{
  const ints = validateEnv({ N: { type: 'int', required: true } }, { N: '42' });
  assert.strictEqual(ints.N, 42);
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '-3' }).N, -3);
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '1e3' }).N, 1000); // 1e3 is a whole value
  assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: '1.5e2' }).N, 150); // 1.5e2 is whole too
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: '3.5' }), /expected an integer/);
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: 'abc' }), /expected an integer/);
  // min/max: both, min alone, max alone; the error names the allowed range.
  assert.strictEqual(validateEnv({ N: { type: 'number', min: 1, max: 10 } }, { N: '5' }).N, 5);
  assert.throws(() => validateEnv({ N: { type: 'number', min: 1 } }, { N: '0' }), /at least 1/);
  assert.throws(() => validateEnv({ N: { type: 'number', max: 10 } }, { N: '11' }), /at most 10/);
  assert.throws(() => validateEnv({ N: { type: 'number', min: 1, max: 10 } }, { N: '99' }), /1\u201310/);
  // min/max also apply to int and port.
  assert.strictEqual(validateEnv({ N: { type: 'int', min: 0 } }, { N: '7' }).N, 7);
  assert.throws(() => validateEnv({ N: { type: 'int', min: 0 } }, { N: '-1' }), /at least 0/);
  assert.throws(() => validateEnv({ P: { type: 'port', max: 1024 } }, { P: '8080' }), /at most 1024/);
  // min/max leave non-numeric values alone.
  assert.strictEqual(validateEnv({ S: { type: 'string', min: 1 } }, { S: 'x' }).S, 'x');
}

// Issue #219: numeric env strings are decimal, not JavaScript radix literals.
{
  const expected = { number: 'expected a number', int: 'expected an integer', port: 'expected a port' };
  for (const type of ['number', 'int', 'port']) {
    for (const raw of ['0x10', '0X10', '0b101', '0B101', '0o17', '0O17']) {
      for (const trim of [true, false]) {
        for (const value of [raw, ` \t${raw}\n`]) {
          assert.throws(
            () => validateEnv({ N: { type, trim } }, { N: value }),
            err => err instanceof EnvSaafError && err.errors[0].includes(`N: ${expected[type]}`),
          );
          assert.throws(
            () => validateEnv({ N: { type: 'array', of: type, trim } }, { N: `1,${value}` }),
            err => err instanceof EnvSaafError && err.errors[0].includes(`N[1]: ${expected[type]}`),
          );
        }
      }
      assert.throws(() => validateEnv({ N: { type, default: raw } }, {}), EnvSaafError);
    }
    for (const [raw, value] of [['42', 42], ['+42', 42], ['042', 42], ['1e3', 1000], ['0', 0]]) {
      for (const trim of [true, false]) {
        assert.strictEqual(validateEnv({ N: { type, trim } }, { N: ` ${raw} ` }).N, value);
        assert.deepStrictEqual(
          validateEnv({ N: { type: 'array', of: type, trim } }, { N: ` ${raw} ,1` }).N,
          [value, 1],
        );
      }
    }
    for (const value of [0x10, 0b101, 0o17]) {
      assert.strictEqual(validateEnv({ N: { type, default: value } }, {}).N, value);
      assert.strictEqual(validateEnv({ N: { type } }, { N: value }).N, value);
    }
    assert.deepStrictEqual(
      validateEnv({ N: { type: 'array', of: type, default: [16, 5, 15] } }, {}).N,
      [16, 5, 15],
    );
    const result = validateEnv({ N: { type, sensitive: true } }, { N: '0x1F90' }, { throwOnError: false });
    assert.deepStrictEqual(result.env, {});
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0].includes(expected[type]));
    assert.ok(!result.errors[0].includes('0x1F90'));
  }
  assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: '.5' }).N, 0.5);
  for (const type of ['number', 'int']) {
    assert.strictEqual(validateEnv({ N: { type } }, { N: '-3' }).N, -3);
  }
  assert.strictEqual(validateEnv({ N: { type: 'string' } }, { N: '0x10' }).N, '0x10');
}

// Issues #32 + #48: 'json' type (parse JSON values) and minLength/maxLength for strings.
{
  // json: objects, arrays and primitives are parsed and returned as-is.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json', required: true } }, { F: '{"beta":true,"maxItems":3}' }).F,
    { beta: true, maxItems: 3 });
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json' } }, { F: '[1, "two", null]' }).F, [1, 'two', null]);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: '42' }).F, 42);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: '"hello"' }).F, 'hello');
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: 'true' }).F, true);
  assert.strictEqual(validateEnv({ F: { type: 'json' } }, { F: 'null' }).F, null);
  // Invalid JSON is a normal collected error naming the key.
  assert.throws(() => validateEnv({ F: { type: 'json' } }, { F: '{not json' }), /expected valid JSON/);
  assert.throws(() => validateEnv({ F: { type: 'json', required: true } }, { F: '' }), /missing required variable/);
  // A default may be given as an already-parsed object.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json', default: { beta: false } } }, {}).F, { beta: false });
  // An already-parsed value passed directly in the env object passes through.
  assert.deepStrictEqual(
    validateEnv({ F: { type: 'json' } }, { F: { beta: true } }).F, { beta: true });
  // json works with required/default like every other type.
  assert.throws(() => validateEnv({ F: { type: 'json', required: true } }, {}), EnvSaafError);

  // minLength/maxLength: both, min alone, max alone; the error names the allowed length.
  assert.strictEqual(validateEnv({ S: { type: 'string', minLength: 2, maxLength: 5 } }, { S: 'abc' }).S, 'abc');
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 3 } }, { S: 'ab' }), /at least 3 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', maxLength: 2 } }, { S: 'abc' }), /at most 2 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 2, maxLength: 4 } }, { S: 'abcdef' }), /2\u20134 characters/);
  // Length is checked after coercion, so surrounding whitespace is trimmed first.
  assert.strictEqual(validateEnv({ S: { type: 'string', minLength: 3, maxLength: 3 } }, { S: '  abc  ' }).S, 'abc');
  // Combines with pattern: length is checked first, then the pattern.
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 5, pattern: /^[a-z]+$/ } }, { S: 'ab1' }), /at least 5 characters/);
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: 2, pattern: /^[a-z]+$/ } }, { S: 'ab1' }), /expected to match/);
  // Applies to email and url values too; non-string types are rejected up front.
  assert.throws(() => validateEnv({ E: { type: 'email', maxLength: 5 } }, { E: 'a@b.co' }), /at most 5 characters/);
  assert.throws(() => validateEnv({ N: { type: 'number', minLength: 5 } }, { N: '42' }), /N: "minLength" only applies to string types/);
  // Bad option values are a clear rule error, not a crash.
  assert.throws(() => validateEnv({ S: { type: 'string', minLength: -1 } }, { S: 'abc' }), /non-negative integers/);
  assert.throws(() => validateEnv({ S: { type: 'string', maxLength: 2.5 } }, { S: 'abc' }), /non-negative integers/);
}

// Issues #37 + #42: 'uuid' type (canonical UUIDs) and 'hex' type
// (hex strings, with an optional exact `length` for fixed-size values).
{
  // uuid: lowercase, uppercase and mixed-case hex all pass, returned unchanged.
  assert.strictEqual(
    validateEnv({ ID: { type: 'uuid' } }, { ID: '550e8400-e29b-41d4-a716-446655440000' }).ID,
    '550e8400-e29b-41d4-a716-446655440000');
  assert.strictEqual(
    validateEnv({ ID: { type: 'uuid' } }, { ID: '550E8400-E29B-41D4-A716-446655440000' }).ID,
    '550E8400-E29B-41D4-A716-446655440000');
  assert.strictEqual(
    validateEnv({ ID: { type: 'uuid' } }, { ID: '550e8400-E29B-41d4-A716-446655440000' }).ID,
    '550e8400-E29B-41d4-A716-446655440000');
  // Malformed UUIDs are rejected with an error naming the key.
  for (const bad of [
    '550e8400e29b41d4a716446655440000', // no dashes
    '550e8400-e29b-41d4-a716', // too short
    '550e8400-e29b-41d4-a716-44665544000g', // non-hex character
    '550e8400-e29b-41d4-a716-446655440000-extra', // too long
    'not-a-uuid',
  ]) {
    assert.throws(() => validateEnv({ ID: { type: 'uuid' } }, { ID: bad }), /expected a valid UUID/);
  }
  assert.throws(() => validateEnv({ ID: { type: 'uuid', required: true } }, {}), EnvSaafError);

  // hex: mixed-case hex passes, returned unchanged.
  assert.strictEqual(validateEnv({ H: { type: 'hex' } }, { H: 'deadBEEF42' }).H, 'deadBEEF42');
  assert.strictEqual(validateEnv({ H: { type: 'hex' } }, { H: '00ff' }).H, '00ff');
  for (const bad of ['deadbeefzz', '0x1234', '12 34', 'café']) {
    assert.throws(() => validateEnv({ H: { type: 'hex' } }, { H: bad }), /expected a hexadecimal string/);
  }
  // length: an exact-length value passes, anything else fails naming the length.
  assert.strictEqual(validateEnv({ H: { type: 'hex', length: 6 } }, { H: 'a1b2c3' }).H, 'a1b2c3');
  assert.throws(() => validateEnv({ H: { type: 'hex', length: 6 } }, { H: 'a1b2' }), /6 characters long/);
  assert.throws(() => validateEnv({ H: { type: 'hex', length: 6 } }, { H: 'a1b2c3d4' }), /6 characters long/);
  // A bad length option is a clear rule error, not a crash.
  assert.throws(() => validateEnv({ H: { type: 'hex', length: -1 } }, { H: 'a1' }), /"length" must be a non-negative integer/);
  assert.throws(() => validateEnv({ H: { type: 'hex', length: 2.5 } }, { H: 'a1' }), /"length" must be a non-negative integer/);
  // minLength/maxLength also work on hex values — they are strings.
  assert.throws(() => validateEnv({ H: { type: 'hex', maxLength: 2 } }, { H: 'a1b2' }), /at most 2 characters/);
}

// Issues #38 + #39 + #43: 'ipv4', 'semver' and 'base64' types. All three
// return the value unchanged; a bad value is rejected naming the key.
{
  // ipv4: four octets, each 0-255; a leading zero is rejected (except '0' itself).
  assert.strictEqual(validateEnv({ IP: { type: 'ipv4' } }, { IP: '192.168.0.1' }).IP, '192.168.0.1');
  assert.strictEqual(validateEnv({ IP: { type: 'ipv4' } }, { IP: '0.0.0.0' }).IP, '0.0.0.0');
  assert.strictEqual(validateEnv({ IP: { type: 'ipv4' } }, { IP: '255.255.255.255' }).IP, '255.255.255.255');
  for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', 'example.com', '01.2.3.4', '192.168.0', '192.168.0.1/24']) {
    assert.throws(() => validateEnv({ IP: { type: 'ipv4' } }, { IP: bad }), /expected a valid IPv4 address/);
  }
  assert.throws(() => validateEnv({ IP: { type: 'ipv4', required: true } }, {}), EnvSaafError);

  // semver: MAJOR.MINOR.PATCH, one optional lowercase 'v' prefix; pre-release and build suffixes pass.
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: '1.2.3' }).V, '1.2.3');
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: '1.2.3-beta.1' }).V, '1.2.3-beta.1');
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: '0.0.1+build.5' }).V, '0.0.1+build.5');
  // Issue #227: a 'v' prefix is accepted and returned unchanged, prefix included.
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: 'v1.2.3' }).V, 'v1.2.3');
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: 'v1.2.3-rc.1' }).V, 'v1.2.3-rc.1');
  assert.strictEqual(validateEnv({ V: { type: 'semver' } }, { V: 'v1.2.3+build' }).V, 'v1.2.3+build');
  for (const bad of ['1.2', 'v1.2', 'vv1.2.3', 'v', 'V1.2.3', '1.02.3', '1.2.3.4', 'latest', '1.2.x']) {
    assert.throws(() => validateEnv({ V: { type: 'semver' } }, { V: bad }), /expected a valid semantic version/);
  }

  // Base64 accepts either alphabet with optional complete padding.
  const base64Schema = { B: { type: 'base64', trim: false } };
  for (const value of [
    'aGVsbG8=', 'aGVsbG8gd29ybGQ=', 'AA==', 'aGVsbG8', 'AA', 'AAAA',
    '+/8=', '+/8', '-_8=', '-_8', '/w==', '/w', '_w==', '_w', '+/AA', '-_AA',
  ]) {
    assert.strictEqual(validateEnv(base64Schema, { B: value }).B, value);
  }
  for (const bad of [
    'not!!base64', 'a', 'AAAAA', 'aGVsbG8===', '====', 'AA=', 'AAA==',
    'AAAA=', 'A===', 'AA=A', 'AA==AAAA', 'AA A', 'AA==\n', '+_8=', '-/8',
  ]) {
    assert.throws(() => validateEnv(base64Schema, { B: bad }), /expected a valid base64 string/);
  }
  // minLength/maxLength work on the new string types too.
  assert.throws(() => validateEnv({ IP: { type: 'ipv4', minLength: 20 } }, { IP: '1.2.3.4' }), /at least 20 characters/);
}

// Issue #40: 'date' type — ISO 8601 dates and datetimes become Date objects.
// Impossible dates are rejected instead of rolling over to the next month.
{
  // date-only: parsed as a Date at UTC midnight.
  const d = validateEnv({ D: { type: 'date' } }, { D: '2026-01-31' }).D;
  assert.ok(d instanceof Date);
  assert.strictEqual(d.toISOString(), '2026-01-31T00:00:00.000Z');
  // leap day is real in a leap year, impossible otherwise.
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2024-02-29' }).D.toISOString().slice(0, 10), '2024-02-29');
  assert.throws(() => validateEnv({ D: { type: 'date' } }, { D: '2026-02-29' }), /expected a valid ISO 8601 date/);
  // full datetimes: UTC, an offset, and fractional seconds all parse.
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2026-01-31T10:00:00Z' }).D.toISOString(), '2026-01-31T10:00:00.000Z');
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2026-01-31T10:00:00+05:30' }).D.toISOString(), '2026-01-31T04:30:00.000Z');
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2026-01-31T10:00:00.123Z' }).D.toISOString(), '2026-01-31T10:00:00.123Z');
  assert.strictEqual(validateEnv({ D: { type: 'date' } }, { D: '2026-01-31T10:00' }).D instanceof Date, true);
  // impossible and malformed values are rejected, naming the key.
  for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-01-32', '2026-01-31T25:00:00Z',
    '2026-01-31T10:60:00Z', '31-01-2026', '2026/01/31', 'not-a-date', '2026-1-31']) {
    assert.throws(() => validateEnv({ D: { type: 'date' } }, { D: bad }), /expected a valid ISO 8601 date/);
  }
  assert.throws(() => validateEnv({ D: { type: 'date', required: true } }, {}), EnvSaafError);
  // A Date given as a default passes through; an invalid one fails like a bad value.
  const def = new Date('2026-06-01T00:00:00.000Z');
  assert.strictEqual(validateEnv({ D: { type: 'date', default: def } }, {}).D, def);
  assert.throws(() => validateEnv({ D: { type: 'date', default: new Date('not a date') } }, {}), /expected a valid ISO 8601 date/);
  // generateExample suggests a real date, not a placeholder.
  assert.ok(generateExample({ LAUNCH: { type: 'date', required: true } }).includes('LAUNCH=2026-01-31'));
}

// Issue #41: 'duration' type — human durations ('15m', '2h', '1d') become milliseconds.
{
  const schema = { TIMEOUT: { type: 'duration' } };
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '500ms' }).TIMEOUT, 500);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '30s' }).TIMEOUT, 30000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '15m' }).TIMEOUT, 900000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '2h' }).TIMEOUT, 7200000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1d' }).TIMEOUT, 86400000);
  // A bare number is already milliseconds; decimals and case do not matter.
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '250' }).TIMEOUT, 250);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1.5h' }).TIMEOUT, 5400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '15M' }).TIMEOUT, 900000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: ' 30s ' }).TIMEOUT, 30000);
  // A number passed directly (e.g. as a default) is taken as milliseconds.
  assert.strictEqual(validateEnv({ TIMEOUT: { type: 'duration', default: 5000 } }, {}).TIMEOUT, 5000);
  // min/max work on the millisecond result like on any other number.
  assert.strictEqual(validateEnv({ TIMEOUT: { type: 'duration', min: 1000 } }, { TIMEOUT: '30s' }).TIMEOUT, 30000);
  assert.throws(() => validateEnv({ TIMEOUT: { type: 'duration', min: 1000 } }, { TIMEOUT: '500ms' }), /expected a number at least 1000/);
  // Unknown units, negatives and malformed values are rejected, naming the key.
  for (const bad of ['15x', '15min', '15sec', '-5m', '-1', 'm', '1.2.3h', '1e3s']) {
    assert.throws(() => validateEnv(schema, { TIMEOUT: bad }), /expected a duration/);
  }
  assert.throws(() => validateEnv({ TIMEOUT: { type: 'duration', required: true } }, {}), EnvSaafError);
  // generateExample suggests a real duration, not a placeholder.
  assert.ok(generateExample({ TIMEOUT: { type: 'duration', required: true } }).includes('TIMEOUT=15m'));
  // Issue #176: 'w' is a week of 7 days, case-insensitive, fractional values allowed.
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1w' }).TIMEOUT, 604800000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '2w' }).TIMEOUT, 1209600000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1W' }).TIMEOUT, 604800000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1.5w' }).TIMEOUT, 907200000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: ' 1 w ' }).TIMEOUT, 604800000);
  assert.strictEqual(validateEnv({ TIMEOUT: { type: 'duration', max: 604800000 } }, { TIMEOUT: '1w' }).TIMEOUT, 604800000);
  assert.throws(() => validateEnv({ TIMEOUT: { type: 'duration', max: 604800000 } }, { TIMEOUT: '2w' }), /expected a number at most 604800000/);
  // Existing units keep their values, and wrong week spellings are still rejected.
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '7d' }).TIMEOUT, validateEnv(schema, { TIMEOUT: '1w' }).TIMEOUT);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1d' }).TIMEOUT, 86400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '2H' }).TIMEOUT, 7200000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '500ms' }).TIMEOUT, 500);
  for (const bad of ['1wk', '1week', '1ww', 'w', '-1w', '1.w', '1e2w']) {
    assert.throws(() => validateEnv(schema, { TIMEOUT: bad }), /expected a duration/);
  }
  // Issue #224: compound durations sum their parts.
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1h30m' }).TIMEOUT, 5400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1h 30m' }).TIMEOUT, 5400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '2d12h' }).TIMEOUT, 216000000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '500ms250ms' }).TIMEOUT, 750);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1.5h30m' }).TIMEOUT, 7200000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1H30M' }).TIMEOUT, 5400000);
  assert.strictEqual(validateEnv(schema, { TIMEOUT: '1w1d' }).TIMEOUT, 691200000);
  // min/max apply to the summed total.
  assert.strictEqual(validateEnv({ TIMEOUT: { type: 'duration', max: 5400000 } }, { TIMEOUT: '1h30m' }).TIMEOUT, 5400000);
  assert.throws(() => validateEnv({ TIMEOUT: { type: 'duration', max: 5399999 } }, { TIMEOUT: '1h30m' }), /expected a number at most 5399999/);
  // A trailing bare number, a leading unit and mixed junk are rejected.
  for (const bad of ['1h30', 'h30m', '1h30x', '1h 30', '1h30min']) {
    assert.throws(() => validateEnv(schema, { TIMEOUT: bad }), /expected a duration/);
  }
  // Array items share the coercion path.
  assert.deepStrictEqual(
    validateEnv({ TIMEOUTS: { type: 'array', of: 'duration' } }, { TIMEOUTS: '1h30m,45s' }).TIMEOUTS,
    [5400000, 45000]);
}

// Issue #44: 'host' type — a hostname or IP address, with no scheme, path or port.
{
  const schema = { HOST: { type: 'host' } };
  assert.strictEqual(validateEnv(schema, { HOST: 'db.internal' }).HOST, 'db.internal');
  assert.strictEqual(validateEnv(schema, { HOST: 'localhost' }).HOST, 'localhost');
  assert.strictEqual(validateEnv(schema, { HOST: '10.0.0.5' }).HOST, '10.0.0.5');
  assert.strictEqual(validateEnv(schema, { HOST: '::1' }).HOST, '::1');
  assert.strictEqual(validateEnv(schema, { HOST: '2001:db8::1' }).HOST, '2001:db8::1');
  assert.strictEqual(validateEnv(schema, { HOST: 'DB.EXAMPLE.COM' }).HOST, 'DB.EXAMPLE.COM');
  // A scheme, a path or a port is rejected, naming the key.
  for (const bad of ['https://db.internal', 'http://localhost:3000', 'db.internal:8080', 'localhost:3000',
    'db/x', 'db.internal/', 'http://[::1]:8080', '-bad-.example.com', 'bad..host', '.example.com', 'example.com.']) {
    assert.throws(() => validateEnv(schema, { HOST: bad }), /expected a hostname or IP address/);
  }
  assert.throws(() => validateEnv({ HOST: { type: 'host', required: true } }, {}), EnvSaafError);
  // String options work on it like on any other string type.
  assert.throws(() => validateEnv({ HOST: { type: 'host', maxLength: 5 } }, { HOST: 'db.internal' }), /at most 5 characters/);
  // generateExample suggests a real host, not a placeholder.
  assert.ok(generateExample({ HOST: { type: 'host', required: true } }).includes('HOST=localhost'));
}

// Issue #82: parseEnvFile takes .env TEXT, not a file path. Passing a path
// silently returned {}; now it throws a clear error pointing at loadEnv.
{
  const helpful = /parseEnvFile expects \.env text, not a file path.*did you mean loadEnv\(schema, \{ path:/;
  assert.throws(() => parseEnvFile('.env'), helpful);
  assert.throws(() => parseEnvFile('config/.env.local'), helpful);
  assert.throws(() => parseEnvFile('/etc/app.env'), helpful);
  // Normal .env text still parses as before — including a single line with
  // no trailing newline and an empty file.
  assert.deepStrictEqual(parseEnvFile('A=1'), { A: '1' });
  assert.deepStrictEqual(parseEnvFile('FOO=bar'), { FOO: 'bar' });
  assert.deepStrictEqual(parseEnvFile(''), {});
  // A lone comment line is not a path, even when it mentions one.
  assert.deepStrictEqual(parseEnvFile('# see config/notes'), {});
}

// Issue #145: bare lines report their position, even after multiline values.
{
  assert.throws(() => parseEnvFile('FOO\n'), /line 1: expected KEY=VALUE/);
  assert.throws(
    () => parseEnvFile('PORT=3000\r\nCERT="one\r\ntwo"\r\nFOO # example=123\r\nBAR=\r\n'),
    /line 4: expected KEY=VALUE/
  );
  assert.deepStrictEqual(parseEnvFile('\r\n# comment\r\n \t\r\n'), {});
  assert.deepStrictEqual(parseEnvFile('BAR=\n'), { BAR: '' });
}

// CLI callers retain readable errors and the machine-readable JSON contract.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-bare-line-'));
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), ...args], {
    encoding: 'utf8',
  });
  try {
    fs.writeFileSync(path.join(dir, '.env.example'), '# config\nFOO\n');
    const scan = run('scan', dir, '--json');
    assert.strictEqual(scan.status, 2);
    assert.strictEqual(scan.stderr, '');
    const error = JSON.parse(scan.stdout);
    assert.strictEqual(error.ok, false);
    assert.match(error.error, /\.env\.example: line 2: expected KEY=VALUE/);

    fs.writeFileSync(path.join(dir, '.env.example'), 'FOO=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'fake secret value accidentally written on its own line\n');
    const check = run('check', dir);
    assert.strictEqual(check.status, 2);
    assert.strictEqual(check.stdout, '');
    assert.match(check.stderr, /\.env: line 1: expected KEY=VALUE/);
    assert.doesNotMatch(check.stderr, /fake secret value/);

    // Issue #221: invalid assignment keys use the same CLI error contract.
    fs.writeFileSync(path.join(dir, '.env.example'), '# config\napp.name=private-value\n');
    const invalidKey = run('scan', dir, '--json');
    assert.strictEqual(invalidKey.status, 2);
    assert.strictEqual(invalidKey.stderr, '');
    const invalidKeyError = JSON.parse(invalidKey.stdout);
    assert.strictEqual(invalidKeyError.ok, false);
    assert.match(invalidKeyError.error, /\.env\.example: line 2: expected KEY=VALUE/);
    assert.doesNotMatch(invalidKey.stdout, /private-value/);

    fs.writeFileSync(path.join(dir, '.env.example'), 'FOO=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'FOO=ok\r\nMY-KEY=private-value\r\n');
    const invalidEnv = run('check', dir);
    assert.strictEqual(invalidEnv.status, 2);
    assert.strictEqual(invalidEnv.stdout, '');
    assert.match(invalidEnv.stderr, /\.env: line 2: expected KEY=VALUE/);
    assert.doesNotMatch(invalidEnv.stderr, /private-value/);
    const target = {};
    assert.throws(
      () => require('./index').loadEnv({ FOO: { type: 'string' } }, {
        path: path.join(dir, '.env'), env: target, assign: true,
      }),
      err => err instanceof SyntaxError && err.message === 'line 2: expected KEY=VALUE',
    );
    assert.deepStrictEqual(target, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #88: loadEnv with assign: true must JSON-stringify object/array values.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-assign-json-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'CFG={"a":1}\nLIST=[1,2,3]\nN=42\nFLAG=true\nNAME=hi\nNOTHING=null\n');
  const schema = {
    CFG: { type: 'json', required: true },
    LIST: { type: 'json', required: true },
    N: { type: 'number', required: true },
    FLAG: { type: 'boolean', required: true },
    NAME: { type: 'string', required: true },
    NOTHING: { type: 'json', required: true },
  };
  const target = {};
  const validated = loadEnv(schema, { path: file, env: target, assign: true });
  // The validated result is unchanged (parsed objects), only the assigned-back copy is text.
  assert.deepStrictEqual(validated.CFG, { a: 1 });
  assert.deepStrictEqual(validated.LIST, [1, 2, 3]);
  // Objects/arrays from the json type round-trip through JSON.parse.
  assert.strictEqual(target.CFG, '{"a":1}');
  assert.deepStrictEqual(JSON.parse(target.CFG), { a: 1 });
  assert.strictEqual(target.LIST, '[1,2,3]');
  assert.deepStrictEqual(JSON.parse(target.LIST), [1, 2, 3]);
  // Primitives keep their existing String(value) behaviour.
  assert.strictEqual(target.N, '42');
  assert.strictEqual(target.FLAG, 'true');
  assert.strictEqual(target.NAME, 'hi');
  // null stays "null".
  assert.strictEqual(target.NOTHING, 'null');

  // A transform returning an object is also JSON-stringified on assign.
  const t2 = {};
  loadEnv(
    { OBJ: { type: 'json', required: true, transform: (v) => ({ raw: v }) } },
    { path: (() => { const f = path.join(dir, '.env2'); fs.writeFileSync(f, 'OBJ=\'"x"\'\n'); return f; })(), env: t2, assign: true }
  );
  assert.strictEqual(t2.OBJ, '{"raw":"x"}');
  assert.deepStrictEqual(JSON.parse(t2.OBJ), { raw: 'x' });
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #117: parseEnvFile — a backslash-escaped quote inside a quoted value
// is part of the value, not the end of it. Single and double quotes behave the
// same way; a plain backslash (C:\path) is not an escape and stays literal.
{
  assert.deepStrictEqual(parseEnvFile(String.raw`B='it\'s'`), { B: "it's" });
  assert.deepStrictEqual(parseEnvFile(String.raw`D="it\"s"`), { D: 'it"s' });
  assert.deepStrictEqual(
    parseEnvFile(String.raw`E='C:\path\to'`),
    { E: String.raw`C:\path\to` }
  );
  // The escaped quote on the first line must not close a multiline value.
  assert.deepStrictEqual(
    parseEnvFile("G='line1\\'s\nline2'\n"),
    { G: "line1's\nline2" }
  );
}

// Issue #114: a default goes through the same coercion and validation as a
// provided value; a bad default fails with the key named, a supplied value wins.
{
  const bad = (schema, key) => assert.throws(
    () => validateEnv(schema, {}),
    (e) => e instanceof EnvSaafError && e.errors.some((m) => m.startsWith(key + ':'))
  );
  bad({ P: { type: 'port', default: 99999 } }, 'P');
  bad({ M: { choices: ['a', 'b'], default: 'c' } }, 'M');
  bad({ N: { type: 'number', default: 'notanumber' } }, 'N');
  bad({ R: { type: 'int', min: 1, max: 5, default: 9 } }, 'R');
  // An empty value counts as missing, so the default is checked then too.
  assert.throws(() => validateEnv({ P: { type: 'port', default: 99999 } }, { P: '' }), /P:/);
  // Valid defaults still work, and are coerced like real values.
    assert.deepStrictEqual({ ...validateEnv({
    P: { type: 'port', default: 3000 },
    L: { choices: ['info', 'warn'], default: 'info' },
    B: { type: 'boolean', default: 'yes' },
    J: { type: 'json', default: { a: 1 } },
  }, {}) }, { P: 3000, L: 'info', B: true, J: { a: 1 } });
  // A supplied value overrides the default (and a bad default is never checked then).
  assert.strictEqual(validateEnv({ P: { type: 'port', default: 99999 } }, { P: '8080' }).P, 8080);
  // transform still runs only on provided values.
  assert.strictEqual(validateEnv({ T: { default: 'a', transform: (v) => v + '!' } }, {}).T, 'a');
}

// Issue #115: scanCode reads code, not the text inside comments or literals.
{
  // A mention in a comment or a literal is not a read.
  assert.deepStrictEqual(scanCode('// set process.env.FOO first'), []);
  assert.deepStrictEqual(scanCode('/* use process.env.BAR */'), []);
  assert.deepStrictEqual(scanCode('const s = "see process.env.BAZ in docs"'), []);
  assert.deepStrictEqual(scanCode("const t = 'process.env.QUX'"), []);
  assert.deepStrictEqual(scanCode('const u = `see process.env.QUUX in docs`'), []);
  assert.deepStrictEqual(scanCode('const r = /process.env.REGEX/;'), []);   // a regex literal, not a read
  // A block comment spanning lines is masked across lines.
  assert.deepStrictEqual(scanCode('const a = 1; /* process.env.L\nprocess.env.M */ const b = 2;'), []);
  // A read inside a template's ${...} is a read; the literal text around it is not.
  assert.deepStrictEqual(scanCode('const v = `k=${process.env.REAL} and process.env.FAKE`'), ['REAL']);
  // The reads that must keep working: dot, bracket with a string or template, destructuring.
  assert.deepStrictEqual(scanCode("process.env.A; process.env['B']; process.env[`C`]"), ['A', 'B', 'C']);
  assert.deepStrictEqual(scanCode('const { D, E: alias = 1, F = "x" } = process.env;'), ['D', 'E', 'F']);
  // A real read and a decoy on the same line: only the read counts.
  assert.deepStrictEqual(scanCode('const g = process.env.G; // process.env.H is not read'), ['G']);
  // Destructuring that only appears in a comment is not a read.
  assert.deepStrictEqual(scanCode('// const { I } = process.env'), []);
  // An escaped quote doesn't end the literal early and expose what follows it.
  assert.deepStrictEqual(scanCode("const j = 'it\\'s process.env.J'; process.env.K"), ['K']);
  // The library's own doc comment mentions process.env.KEY: scanning index.js is not a read of KEY.
  const own = require('node:fs').readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
  assert.ok(!scanCode(own).includes('KEY'));
}

// Issue #90: CLI check --schema validates values against a schema, not just presence.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-schema-'));

  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const p = process.env.PORT;\nconst d = process.env.DEBUG;');
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\nDEBUG=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=not-a-port\nDEBUG=yes\n');
    fs.writeFileSync(path.join(dir, 'env.schema.js'),
      "'use strict';\nmodule.exports = { PORT: { type: 'port', required: true }, DEBUG: { type: 'boolean' } };\n");

    // A wrong-typed value in the real .env fails the check, naming the key, exit 1.
    const bad = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(bad.status, 1);
    assert.ok(bad.stdout.includes('INVALID: PORT: expected a port (0-65535, e.g. 3000), got "not-a-port"'), bad.stdout);
    assert.ok(!bad.stdout.includes('DEBUG'), bad.stdout);

    // --json reports the failure in the existing `invalid` field.
    const json = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js', '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 1);
    assert.deepStrictEqual(JSON.parse(json.stdout), {
      ok: false,
      missing: [],
      extra: [],
      unused: [],
      invalid: ['PORT: expected a port (0-65535, e.g. 3000), got "not-a-port"'],
      envExtra: [],
      envMissing: [],
    });

    // Valid values pass, and presence-only (no --schema) never flags values.
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\nDEBUG=yes\n');
    const good = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(good.status, 0);
    assert.ok(good.stdout.includes('all clean'));
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=not-a-port\nDEBUG=yes\n');
    const presenceOnly = spawnSync(process.execPath, [cli, 'check', dir], { encoding: 'utf8' });
    assert.strictEqual(presenceOnly.status, 0);
    assert.ok(presenceOnly.stdout.includes('all clean'));
    assert.ok(!presenceOnly.stdout.includes('INVALID'));

    // The template's placeholders are not real values: with no .env the schema
    // step is skipped instead of flagging .env.example.
    fs.rmSync(path.join(dir, '.env'));
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=not-a-port\nDEBUG=\n');
    const skipped = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(skipped.status, 0);
    assert.ok(!skipped.stdout.includes('INVALID'));

    // An explicit --file names the file to validate.
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\nDEBUG=\n');
    fs.writeFileSync(path.join(dir, 'custom.env'), 'PORT=not-a-port\nDEBUG=yes\n');
    const custom = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'env.schema.js', '--file', 'custom.env'], { encoding: 'utf8' });
    assert.strictEqual(custom.status, 1);
    assert.ok(custom.stdout.includes('INVALID: PORT: expected a port (0-65535, e.g. 3000), got "not-a-port"'), custom.stdout);

    // A schema file that cannot be loaded is a usage error (exit 2), not a finding.
    const missing = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'nope.js'], { encoding: 'utf8' });
    assert.strictEqual(missing.status, 2);
    assert.ok(missing.stderr.includes('cannot load schema nope.js'), missing.stderr);
    fs.writeFileSync(path.join(dir, 'bad.schema.js'), "'use strict';\nmodule.exports = 'nope';\n");
    const notObject = spawnSync(process.execPath, [cli, 'check', dir, '--schema', 'bad.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(notObject.status, 2);
    assert.ok(notObject.stderr.includes('must export a schema object'), notObject.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #89: a missing template file must point at the command that drafts one,
// and --json must carry that hint instead of plain text on stderr.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-hint-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const known = process.env.KNOWN;');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const plain = run(['check', dir]);
  assert.strictEqual(plain.status, 2);
  assert.match(plain.stderr, /not found in/);
  assert.match(plain.stderr, /env-saaf example/);
  assert.strictEqual(plain.stdout, '');

  const json = run(['check', dir, '--json']);
  assert.strictEqual(json.status, 2);
  const payload = JSON.parse(json.stdout.trim());
  assert.strictEqual(payload.ok, false);
  assert.match(payload.error, /not found in/);
  assert.match(payload.hint, /env-saaf example/);
  assert.strictEqual(json.stderr, '');

  fs.rmSync(dir, { recursive: true, force: true });
}
// Issue #63: CLI scan also lists keys declared in the template that no code reads, as a
// warning only: stdout stays the plain list, the exit code stays 0.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-unused-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'const a = process.env.USED_KEY;\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'USED_KEY=1\nOLD_KEY=2\n');
    fs.writeFileSync(path.join(dir, '.env.sample'), 'USED_KEY=1\nSAMPLE_ONLY=3\n');

    // Text mode: used vars on stdout (unchanged), the unused key as a warning on stderr
    const plain = run(['scan', dir]);
    assert.strictEqual(plain.status, 0);
    assert.strictEqual(plain.stdout.trim(), 'USED_KEY');
    assert.match(plain.stderr, /UNUSED: OLD_KEY \(in \.env\.example, never used in code\)/);
    assert.ok(!plain.stderr.includes('USED_KEY (in'));

    // --json: an `unused` field next to `vars`, still ok: true and exit 0
    const json = run(['scan', dir, '--json']);
    assert.strictEqual(json.status, 0);
    assert.deepStrictEqual(JSON.parse(json.stdout), { ok: true, vars: ['USED_KEY'], unused: ['OLD_KEY'] });
    assert.strictEqual(json.stderr, '');

    // --file picks another template
    const sample = run(['scan', dir, '--file', '.env.sample', '--json']);
    assert.deepStrictEqual(JSON.parse(sample.stdout).unused, ['SAMPLE_ONLY']);

    // A template where every key is read produces no warning at all
    fs.writeFileSync(path.join(dir, '.env.example'), 'USED_KEY=1\n');
    const clean = run(['scan', dir]);
    assert.strictEqual(clean.status, 0);
    assert.strictEqual(clean.stderr, '');
    assert.deepStrictEqual(JSON.parse(run(['scan', dir, '--json']).stdout), { ok: true, vars: ['USED_KEY'], unused: [] });

    // No template file: nothing to compare, output exactly as before
    fs.rmSync(path.join(dir, '.env.example'));
    const none = run(['scan', dir, '--json']);
    assert.deepStrictEqual(JSON.parse(none.stdout), { ok: true, vars: ['USED_KEY'] });
    assert.strictEqual(none.stderr, '');
    assert.strictEqual(run(['scan', dir]).stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #134: invalid schema rules must be rejected up front, even when no
// value is present to coerce (an absent optional key must not hide a typo).
{
  const unknown = validateEnv.bind(null, { TYPO: { type: 'emial' } }, {});
  assert.throws(unknown, EnvSaafError);
  assert.throws(unknown, /TYPO/);
  assert.throws(unknown, /emial/);

  // The invalid option is reported before any environment value is read.
  assert.throws(() => validateEnv({ K: { type: 'string', pattern: 'not-a-regexp' } }, {}), /"pattern" must be a RegExp/);
  assert.throws(() => validateEnv({ K: { type: 'string', transform: 'nope' } }, {}), /"transform" must be a function/);
  assert.throws(() => validateEnv({ K: { type: 'number', min: 'x' } }, {}), /"min"/);
  assert.throws(() => validateEnv({ K: { type: 'number', max: 'x' } }, {}), /"max"/);
  assert.throws(() => validateEnv({ K: { type: 'hex', length: 'x' } }, {}), /"length"/);

  // Valid rules still validate and coerce exactly as before.
  assert.strictEqual(validateEnv({ OK: { type: 'int', required: true } }, { OK: '42' }).OK, 42);
}

// Issue #133: a directory argument that is a file or does not exist must be
// reported clearly with exit 2, never a raw Node stack trace.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-baddir-'));
  const file = path.join(dir, 'index.js');
  fs.writeFileSync(file, 'process.env.X;');

  try {
    for (const command of ['scan', 'check', 'example']) {
      // missing directory
      const missing = spawnSync(process.execPath, [cli, command, path.join(dir, 'nope')], { encoding: 'utf8' });
      assert.strictEqual(missing.status, 2, `${command} missing`);
      assert.ok(missing.stderr.includes('does not exist'), `${command} missing: ${missing.stderr}`);
      assert.ok(!/at .*readdirSync|ENOENT: no such file or directory, scandir/.test(missing.stderr), 'no stack trace');

      // a file where a directory is expected
      const asFile = spawnSync(process.execPath, [cli, command, file], { encoding: 'utf8' });
      assert.strictEqual(asFile.status, 2, `${command} file`);
      assert.ok(asFile.stderr.includes('is not a directory'), `${command} file: ${asFile.stderr}`);
      assert.ok(!/at .*readdirSync|ENOTDIR/.test(asFile.stderr), 'no stack trace');
    }

    // --json keeps stdout parseable with an error field and the same exit code.
    const json = spawnSync(process.execPath, [cli, 'scan', file, '--json'], { encoding: 'utf8' });
    assert.strictEqual(json.status, 2);
    assert.strictEqual(JSON.parse(json.stdout).ok, false);
    assert.ok(JSON.parse(json.stdout).error.includes('is not a directory'));

    // A real directory is still scanned normally.
    const ok = spawnSync(process.execPath, [cli, 'scan', dir], { encoding: 'utf8' });
    assert.strictEqual(ok.status, 0);
    assert.strictEqual(ok.stdout.trim(), 'X');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #144: duplicates fail through the public entry points without values.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const duplicate = '# comment\r\nPORT=synthetic_first\r\nexport PORT=synthetic_second\r\n';
  const check = (error) => {
    assert.strictEqual(error.message, 'env-saaf: duplicate key PORT at line 3 (first defined at line 2)');
    return true;
  };
  assert.throws(() => parseEnvFile(duplicate), check);
  assert.throws(() => parseEnvFile('A="first\nsecond"\nA=third'), /duplicate key A at line 3 .*line 1/);
  assert.deepStrictEqual(parseEnvFile('A="first\nA=inside"\nB=ok'), { A: 'first\nA=inside', B: 'ok' });
  for (const key of ['constructor', 'toString', 'hasOwnProperty']) {
    assert.strictEqual(parseEnvFile(key + '=ok')[key], 'ok');
    assert.throws(() => parseEnvFile(key + '=one\n' + key + '=two'), /duplicate key/);
  }
  const dir = fs.mkdtempSync(path.join(__dirname, 'duplicate-test-'));
  const file = path.join(dir, '.env');
  try {
    fs.writeFileSync(file, duplicate);
    assert.throws(() => loadEnv({}, { path: file, env: {} }), check);
    fs.writeFileSync(file, 'PORT=3000\nNAME=example\n');
    assert.strictEqual(loadEnv({ PORT: { type: 'port' } }, { path: file, env: {} }).PORT, 3000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #146: empty scans explain success on stderr without polluting stdout.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(__dirname, 'scan-empty-test-'));
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, 'cli.js'), 'scan', dir, ...args], { encoding: 'utf8' });
  try {
    for (const source of [null, 'console.log("hello");\n']) {
      if (source) fs.writeFileSync(path.join(dir, 'app.js'), source);
      const plain = run();
      assert.strictEqual(plain.status, 0);
      assert.strictEqual(plain.stdout, '');
      assert.strictEqual(plain.stderr, 'No process.env usage found.\n');
      const json = run('--json');
      assert.strictEqual(json.status, 0);
      assert.strictEqual(json.stderr, '');
      assert.strictEqual(json.stdout, '{"ok":true,"vars":[]}\n');
    }
    fs.writeFileSync(path.join(dir, 'app.js'), 'process.env.SYNTHETIC_KEY;\n');
    const plain = run();
    assert.strictEqual(plain.status, 0);
    assert.strictEqual(plain.stdout, 'SYNTHETIC_KEY\n');
    assert.strictEqual(plain.stderr, '');
    const json = run('--json');
    assert.strictEqual(json.status, 0);
    assert.strictEqual(json.stderr, '');
    assert.strictEqual(json.stdout, '{"ok":true,"vars":["SYNTHETIC_KEY"]}\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #55: non-throwing mode — return { env, errors } instead of throwing,
// so a health check or a CLI can log every config problem and keep booting.
{
  const schema = {
    PORT: { type: 'port', required: true },
    NAME: { type: 'string' },
    DEBUG: { type: 'boolean', default: false },
  };

  // Default behaviour is unchanged: invalid values still throw.
  assert.throws(() => validateEnv(schema, { PORT: 'not-a-port' }), EnvSaafError);
  assert.throws(() => validateEnv(schema, { PORT: 'not-a-port' }, { throwOnError: true }), EnvSaafError);

  // Invalid values are collected; the values that did validate are returned.
  const partial = validateEnv(schema, { PORT: 'abc', NAME: 'ok', DEBUG: 'yes' }, { throwOnError: false });
  assert.deepStrictEqual(partial.env, { NAME: 'ok', DEBUG: true });
  assert.deepStrictEqual(partial.errors, ['PORT: expected a port (0-65535, e.g. 3000), got "abc"']);

  // A clean environment returns the env the throwing API would and no errors.
  const clean = validateEnv(schema, { PORT: '3000', DEBUG: 'false' }, { throwOnError: false });
  assert.deepStrictEqual(clean.env, { PORT: 3000, DEBUG: false });
  assert.deepStrictEqual(clean.errors, []);

  // The returned list is the EnvSaafError contents, one-to-one.
  const bad = { PORT: 'x', DEBUG: 'maybe' };
  let thrown;
  try { validateEnv(schema, bad); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof EnvSaafError);
  const collected = validateEnv(schema, bad, { throwOnError: false });
  assert.deepStrictEqual(collected.errors, thrown.errors);
  assert.strictEqual(collected.errors.length, 2);

  // strict-mode findings are collected the same way.
  const strict = validateEnv(schema, { PORT: '3000', TYPO: 'x' }, { strict: true, throwOnError: false });
  assert.deepStrictEqual(strict.env, { PORT: 3000, DEBUG: false });
  assert.deepStrictEqual(strict.errors, ['TYPO: set but not in schema (strict mode)']);

  // The returned env is frozen exactly like the throwing API's result.
  assert.ok(Object.isFrozen(strict.env));
  assert.deepStrictEqual(validateEnv({}, {}, { throwOnError: false }), { env: {}, errors: [] });

  // A malformed schema is a bug in the code, not a config problem: it throws
  // even in non-throwing mode, where no result could be trusted.
  assert.throws(() => validateEnv({ TYPO: { type: 'emial' } }, {}, { throwOnError: false }), /emial/);

  // loadEnv keeps throwing: with assign: true it writes into the real env, so
  // a partial result must not be accepted there.
  const fs = require('node:fs');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(__dirname, 'non-throwing-test-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'PORT=not-a-port\n');
    assert.throws(() => loadEnv({ PORT: { type: 'port' } }, { path: file, env: {}, throwOnError: false }), EnvSaafError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #169: exercise the CLI's Windows path handling with an in-memory filesystem.
{
  const fs = require('node:fs');
  const path = require('node:path').win32;
  const { runInNewContext } = require('node:vm');
  const cli = fs.readFileSync(require.resolve('./cli'), 'utf8');
  const dir = 'C:\\project';
  for (const [name, schemaPath, example] of [
    ['D:custom.js', 'D:\\schemas\\custom.js', 'npx env-saaf check . --schema D:/schemas/custom.js'],
    ["schema files/it's custom.js", "C:\\project\\schema files\\it's custom.js",
      `npx env-saaf check . --schema "./schema files/it's custom.js"`],
    ['budget! draft.js', 'C:\\project\\budget! draft.js'],
  ]) {
    const writes = new Map();
    const requireFromCli = id => {
      if (id === 'node:fs') return {
        existsSync: file => file === dir,
        statSync: () => ({ isDirectory: () => true }),
        // Issue #171: init now scans the directory before writing; this stub
        // project has no files, so the scan finds nothing.
        readdirSync: () => [],
        writeFileSync: (file, contents) => writes.set(file, contents),
      };
      if (id === 'node:path') return {
        ...path,
        // Supply D:'s current directory without relying on the host environment.
        resolve: (root, file) => path.resolve(file === 'D:custom.js' ? 'D:\\schemas' : root, file),
      };
      if (id === schemaPath) return {};
      // Issue #171: init scans the directory before writing; this stub
      // project ('C:\\project') does not exist on disk, so hand the CLI a
      // scan that finds nothing instead of the real scanDir.
      if (id === './index') return { ...require('./index'), scanDir: () => [] };
      return require(id);
    };
    requireFromCli.resolve = id => id;
    requireFromCli.cache = {};
    runInNewContext(cli, {
      require: requireFromCli,
      process: { argv: ['node', 'cli.js', 'init', dir, '--schema', name], platform: 'win32' },
    });
    const generated = writes.get(schemaPath);
    assert.ok(generated, schemaPath);
    if (!example) {
      assert.match(generated, /--schema set to this path \(JSON\): "\.\/budget! draft\.js"\n/);
      assert.doesNotMatch(generated, /npx env-saaf check/);
      continue;
    }
    const label = example.includes('"') ? ' (cmd.exe)' : '';
    assert.ok(generated.includes(`// Validate the real .env against it${label}: ${example}\n`), generated);
    const argument = example.split(' --schema ')[1].replace(/^"|"$/g, '');
    assert.strictEqual(path.resolve(dir, argument), schemaPath);
  }
}

// Issue #60: CLI 'init' — scaffold a starter schema + .env.example.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(__dirname, 'init-test-'));
  try {
    // Both files land in an empty directory, with a confirmation on stdout.
    const first = run(['init', dir]);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.ok(first.stdout.includes('env.schema.js') && first.stdout.includes('.env.example'));
    const schemaFile = path.join(dir, 'env.schema.js');
    const exampleFile = path.join(dir, '.env.example');
    assert.ok(fs.existsSync(schemaFile));
    assert.ok(fs.existsSync(exampleFile));
    // The scaffold is a valid schema object, and the .env.example on disk is
    // exactly what generateExample produces from it — the two cannot drift.
    const starter = require(schemaFile);
    const types = Object.values(starter).map(rule => rule.type);
    for (const t of ['string', 'int', 'boolean', 'port', 'url', 'email']) {
      assert.ok(types.includes(t), `starter schema should demonstrate ${t}`);
    }
    assert.strictEqual(fs.readFileSync(exampleFile, 'utf8'), generateExample(starter));
    assert.deepStrictEqual(
      Object.keys(starter),
      fs.readFileSync(exampleFile, 'utf8').split('\n')
        .filter(l => l && !l.startsWith('#')).map(l => l.split('=')[0]),
    );

    // Refuses to overwrite either file without --force, naming what exists,
    // and the files keep their content.
    const before = fs.readFileSync(schemaFile, 'utf8');
    assert.match(before, /npx env-saaf check \. --schema \.\/env\.schema\.js$/m);
    const again = run(['init', dir]);
    assert.strictEqual(again.status, 1);
    assert.match(again.stderr, /already exist/);
    assert.match(again.stderr, /--force/);
    assert.strictEqual(fs.readFileSync(schemaFile, 'utf8'), before);

    // --force overwrites both files: a hand-edited schema is replaced by the
    // scaffold again.
    fs.writeFileSync(schemaFile, 'module.exports = { HAND_EDITED: true };\n');
    const forced = run(['init', dir, '--force']);
    assert.strictEqual(forced.status, 0, forced.stderr);
    assert.strictEqual(fs.readFileSync(schemaFile, 'utf8'), before);
    assert.strictEqual(fs.readFileSync(exampleFile, 'utf8'), generateExample(starter));

    // --schema names the schema file; the .env.example is still generated.
    const dir2 = fs.mkdtempSync(path.join(dir, 'named-'));
    try {
      const assertSchemaExample = (schema, argument) => {
        const named = run(['init', dir2, '--force', '--schema', schema]);
        assert.strictEqual(named.status, 0, named.stderr);
        const generated = fs.readFileSync(path.resolve(dir2, schema), 'utf8');
        assert.ok(generated.includes(`npx env-saaf check . --schema ${argument}\n`), generated);
      };
      assertSchemaExample('custom.js', './custom.js');
      assert.ok(fs.existsSync(path.join(dir2, '.env.example')));

      assertSchemaExample('../parent.js', './../parent.js');
      fs.mkdirSync(path.join(dir2, 'schema files'));
      const absolute = path.join(dir2, 'schema files', 'absolute.js');
      const absoluteArg = absolute.split(path.sep).join('/');
      if (process.platform === 'win32') {
        assertSchemaExample('schema files/custom.js', '"./schema files/custom.js"');
        if (/^[\w./: '()-]+$/.test(absoluteArg)) {
          assertSchemaExample(absolute, `"${absoluteArg}"`);
        }
      } else {
        assertSchemaExample('schema files/custom.js', "'./schema files/custom.js'");
        assertSchemaExample(absolute, `'${absoluteArg.replace(/'/g, `'"'"'`)}'`);
      }

      if (process.platform !== 'win32') {
        assertSchemaExample("it's $config.js", "'./it'\"'\"'s $config.js'");
        assertSchemaExample('line\nbreak.js', "$'./line\\nbreak.js'");
        assertSchemaExample('line\u2028separator.js', "$'./line\\342\\200\\250separator.js'");
      }
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #175: 'number' and 'int' reject non-finite values (Infinity, -Infinity, exponent overflow).
{
  const nonFinite = ['Infinity', '-Infinity', '+Infinity', '1e999', '-1e999', ' Infinity ', ' 1e999 '];
  for (const raw of nonFinite) {
    assert.throws(
      () => validateEnv({ N: { type: 'number' } }, { N: raw }),
      err => err instanceof EnvSaafError && err.errors.length === 1
        && err.errors[0] === `N: expected a number (e.g. 3.14), got "${raw}"`,
    );
    assert.throws(
      () => validateEnv({ N: { type: 'int' } }, { N: raw }),
      err => err instanceof EnvSaafError && err.errors.length === 1
        && err.errors[0] === `N: expected an integer (e.g. 42), got "${raw}"`,
    );
  }
  // Non-finite values cannot slip past a lower bound like min: 0 either.
  assert.throws(
    () => validateEnv({ N: { type: 'number', min: 0 } }, { N: 'Infinity' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'N: expected a number (e.g. 3.14), got "Infinity"',
  );
  // Non-finite defaults are rejected just like env inputs.
  for (const def of [Infinity, -Infinity, '1e999']) {
    assert.throws(
      () => validateEnv({ N: { type: 'number', default: def } }, {}),
      err => err instanceof EnvSaafError && err.errors[0] === `N: expected a number (e.g. 3.14), got "${def}"`,
    );
    assert.throws(
      () => validateEnv({ N: { type: 'int', default: def } }, {}),
      err => err instanceof EnvSaafError && err.errors[0] === `N: expected an integer (e.g. 42), got "${def}"`,
    );
  }
  // Non-throwing mode collects the error and omits the key.
  const collected = validateEnv({ N: { type: 'number' } }, { N: '1e999' }, { throwOnError: false });
  assert.deepStrictEqual(collected.env, {});
  assert.deepStrictEqual(collected.errors, ['N: expected a number (e.g. 3.14), got "1e999"']);
  // Ordinary finite inputs still pass for both 'number' and 'int'.
  for (const [raw, expected] of [['0', 0], ['42', 42], ['-7', -7], ['3.14', 3.14], ['-0.5', -0.5], ['1e3', 1000], ['1.5e-2', 0.015]]) {
    assert.strictEqual(validateEnv({ N: { type: 'number' } }, { N: raw }).N, expected);
  }
  for (const [raw, expected] of [['0', 0], ['42', 42], ['-7', -7], ['1e3', 1000], ['1.5e2', 150]]) {
    assert.strictEqual(validateEnv({ N: { type: 'int' } }, { N: raw }).N, expected);
  }
}

// Issue #58: every built-in type's validation error includes a format example,
// and aggregated errors remain one concise bullet per key.
{
  const cases = [
    ['email', 'not-an-email', 'e.g. user@example.com'],
    ['number', 'not-a-number', 'e.g. 3.14'],
    ['int', '3.5', 'e.g. 42'],
    ['json', '{bad', 'e.g. {"key":"value"}'],
    ['boolean', 'maybe', 'e.g. true/false, yes/no, on/off, 1/0, y/n'],
    ['url', 'not-a-url', 'e.g. https://example.com'],
    ['uuid', 'not-a-uuid', 'e.g. 550e8400-e29b-41d4-a716-446655440000'],
    ['hex', 'not-hex!', 'e.g. deadbeef'],
    ['ipv4', '999.1.1.1', 'e.g. 192.168.0.1'],
    ['semver', '1.2', 'e.g. 1.2.3'],
    ['base64', 'not base64!', 'e.g. aGVsbG8='],
    ['port', 'abc', '0-65535, e.g. 3000'],
    ['date', '2026-02-31', 'e.g. 2026-01-31'],
    ['file', './definitely-missing-env-saaf-file.json', 'e.g. ./config.json'],
    ['duration', '15min', 'e.g. 500ms, 30s, 15m, 2h, 1d, 1w, 1h30m'],
    ['host', 'https://db.internal', 'e.g. db.internal, localhost, 10.0.0.5'],
  ];
  for (const [type, bad, expectedHint] of cases) {
    assert.throws(
      () => validateEnv({ VAL: { type } }, { VAL: bad }),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0].includes(`(${expectedHint})`)
        && err.errors[0].includes(`got "${bad}"`),
      `${type} error should include (${expectedHint})`,
    );
  }

  // Aggregated EnvSaafError stays readable: one single-line bullet per failing key.
  const schema = {};
  const badEnv = {};
  for (const [type, bad] of cases) {
    const key = `BAD_${type.toUpperCase()}`;
    schema[key] = { type, required: true };
    badEnv[key] = bad;
  }
  let aggregated;
  try { validateEnv(schema, badEnv); } catch (e) { aggregated = e; }
  assert.ok(aggregated instanceof EnvSaafError);
  assert.strictEqual(aggregated.errors.length, cases.length);
  const lines = aggregated.message.split('\n');
  assert.strictEqual(lines[0], 'Invalid environment variables:');
  assert.strictEqual(lines.length, cases.length + 1);
  for (let i = 0; i < cases.length; i++) {
    const [type, , expectedHint] = cases[i];
    const key = `BAD_${type.toUpperCase()}`;
    assert.ok(lines[i + 1].startsWith(`  - ${key}: `), lines[i + 1]);
    assert.ok(lines[i + 1].includes(`(${expectedHint})`), lines[i + 1]);
  }
}

// Issue #170 + #178: CLI round-trip — a fresh `init` followed by `check`
// passes with a single note instead of one UNUSED line per scaffolded key,
// and UNUSED fails the check again as soon as code reads a variable.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-roundtrip-'));
  try {
    // init in an empty directory, then check: exit 0, one plain note, no
    // UNUSED lines — the scaffold is ahead of the code, not drift.
    const inited = run(['init', dir]);
    assert.strictEqual(inited.status, 0, inited.stderr);
    const checked = run(['check', dir]);
    assert.strictEqual(checked.status, 0, checked.stdout + checked.stderr);
    assert.ok(checked.stdout.includes('no process.env usage found in code yet'), checked.stdout);
    assert.ok(checked.stdout.includes('8 keys in .env.example are not used by any code yet'), checked.stdout);
    assert.ok(!checked.stdout.includes('UNUSED:'), checked.stdout);
    const checkedJson = JSON.parse(run(['check', dir, '--json']).stdout.trim());
    assert.strictEqual(checkedJson.ok, true);
    assert.deepStrictEqual(checkedJson.extra, []);
    assert.ok(checkedJson.note.includes('no process.env usage found in code yet'), checkedJson.note);
    // --schema with no real .env: the schema step is skipped, the note still rules.
    assert.strictEqual(run(['check', dir, '--schema', './env.schema.js']).status, 0);

    // A real finding still fails even with no code usage: an EXTRA key in .env
    // is not hidden behind the scaffold note.
    fs.writeFileSync(path.join(dir, '.env'), 'TYPO_KEY=1\n');
    const extra = run(['check', dir]);
    assert.strictEqual(extra.status, 1);
    assert.ok(extra.stdout.includes('EXTRA in .env: TYPO_KEY'), extra.stdout);
    fs.rmSync(path.join(dir, '.env'));

    // Once code reads one variable, UNUSED is a finding again (#113): the
    // other seven scaffolded keys fail the check, in text and --json.
    fs.writeFileSync(path.join(dir, 'app.js'), 'const port = process.env.PORT;\n');
    const drifted = run(['check', dir]);
    assert.strictEqual(drifted.status, 1);
    assert.ok(drifted.stdout.includes('UNUSED: APP_NAME'), drifted.stdout);
    assert.ok(!drifted.stdout.includes('no process.env usage found'), drifted.stdout);
    const driftedJson = JSON.parse(run(['check', dir, '--json']).stdout.trim());
    assert.strictEqual(driftedJson.ok, false);
    assert.strictEqual(driftedJson.extra.length, 7);
    assert.strictEqual(driftedJson.note, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #184: CLI 'init' in an ES module project writes env.schema.cjs
// instead of crashing on require() of a .js starter Node treats as ESM.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-esm-'));
  try {
    // A "type": "module" project: init exits 0, writes env.schema.cjs (not
    // env.schema.js) + .env.example, and the whole round-trip works —
    // check passes with the scaffold note, and check --schema validates a
    // real .env against the .cjs schema.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"esmproj","type":"module"}\n');
    const inited = run(['init', dir]);
    assert.strictEqual(inited.status, 0, inited.stderr);
    assert.ok(inited.stdout.includes('env.schema.cjs'), inited.stdout);
    assert.ok(fs.existsSync(path.join(dir, 'env.schema.cjs')));
    assert.ok(!fs.existsSync(path.join(dir, 'env.schema.js')));
    assert.ok(fs.existsSync(path.join(dir, '.env.example')));
    const starter = require(path.join(dir, 'env.schema.cjs'));
    assert.strictEqual(starter.PORT.type, 'port');
    assert.strictEqual(fs.readFileSync(path.join(dir, '.env.example'), 'utf8'), generateExample(starter));
    assert.strictEqual(run(['check', dir]).status, 0);
    fs.writeFileSync(path.join(dir, '.env'),
      'APP_NAME=myapp\nRETRIES=3\nDEBUG=false\nPORT=3000\nAPI_URL=https://example.com\nSUPPORT_EMAIL=a@b.com\nSHUTDOWN_TIMEOUT=15m\nDB_HOST=localhost\n');
    assert.strictEqual(run(['check', dir, '--schema', './env.schema.cjs']).status, 0);
    fs.rmSync(path.join(dir, '.env'));

    // An explicit --schema .js name in the same project is refused cleanly
    // (exit 2, no stack trace) and writes neither file.
    const refused = run(['init', dir, '--force', '--schema', 'custom.js']);
    assert.strictEqual(refused.status, 2, refused.stdout + refused.stderr);
    assert.ok(refused.stderr.includes('.cjs'), refused.stderr);
    assert.ok(!refused.stderr.includes('ReferenceError'), refused.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'custom.js')));

    // check --schema on a .js schema in an ES module project names the fix.
    fs.writeFileSync(path.join(dir, 'bad.js'), "module.exports = { PORT: { type: 'port' } };\n");
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
    const badCheck = run(['check', dir, '--schema', './bad.js']);
    assert.strictEqual(badCheck.status, 2);
    assert.ok(badCheck.stderr.includes('.cjs'), badCheck.stderr);
    assert.ok(!badCheck.stderr.includes('ReferenceError'), badCheck.stderr);
    fs.rmSync(path.join(dir, '.env'));
    fs.rmSync(path.join(dir, 'bad.js'));

    // A CommonJS project is unchanged: the starter is still env.schema.js.
    const cjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-cjs-'));
    try {
      fs.writeFileSync(path.join(cjsDir, 'package.json'), '{"name":"cjsproj","type":"commonjs"}\n');
      const cjsInit = run(['init', cjsDir]);
      assert.strictEqual(cjsInit.status, 0, cjsInit.stderr);
      assert.ok(fs.existsSync(path.join(cjsDir, 'env.schema.js')));
      assert.ok(!fs.existsSync(path.join(cjsDir, 'env.schema.cjs')));
    } finally {
      fs.rmSync(cjsDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #171: `init` scans the directory first (the same scan `check` and
// `example` use) and folds keys the code already reads into the starter schema
// as `{ type: 'string' }` entries, so the generated .env.example covers them
// and the first `check` reports no MISSING lines to merge by hand. A directory
// with no code yet scaffolds exactly as before, and keys the scaffold already
// declares are not duplicated.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const cli = path.join(__dirname, 'cli.js');
  const run = (args) => spawnSync('node', [cli, ...args], { encoding: 'utf8' });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-init-scan-'));
  try {
    // Code already reads FOO and PORT: FOO must be folded into the scaffold,
    // while PORT (already scaffolded) must not be duplicated.
    fs.writeFileSync(path.join(dir, 'app.js'), 'const port = process.env.PORT;\nconst tag = process.env.FOO;\n');
    const inited = run(['init', dir]);
    assert.strictEqual(inited.status, 0, inited.stderr);
    // The discovered keys are listed in init's output.
    assert.ok(inited.stdout.includes('folded in 1 key found by scanning the code: FOO'), inited.stdout);
    const schemaFile = path.join(dir, 'env.schema.js');
    const schemaText = fs.readFileSync(schemaFile, 'utf8');
    assert.match(schemaText, /FOO: \{ type: 'string' \},/);
    assert.match(schemaText, /Found by scanning this project's code/);
    assert.strictEqual(schemaText.match(/^  PORT:/gm).length, 1, schemaText);
    const starter = require(schemaFile);
    assert.deepStrictEqual(starter.FOO, { type: 'string' });
    const exampleText = fs.readFileSync(path.join(dir, '.env.example'), 'utf8');
    assert.match(exampleText, /^FOO=your_value_here$/m);
    assert.strictEqual(exampleText.match(/^PORT=/gm).length, 1, exampleText);
    assert.strictEqual(exampleText, generateExample(starter));

    // The original complaint is gone: the first `check` after init no longer
    // reports the scanned key as MISSING in .env.example (text or --json).
    const checked = run(['check', dir]);
    assert.ok(!checked.stdout.includes('MISSING in .env.example: FOO'), checked.stdout);
    const checkedJson = JSON.parse(run(['check', dir, '--json']).stdout.trim());
    assert.deepStrictEqual(checkedJson.missing, []);

    // Once the code reads every documented key (the folded one included), the
    // whole round trip is clean: check --schema validates a real .env against
    // the folded scaffold with no hand merging.
    fs.writeFileSync(path.join(dir, 'app.js'),
      'const a = process.env.APP_NAME, r = process.env.RETRIES, d = process.env.DEBUG;\n'
      + 'const p = process.env.PORT, u = process.env.API_URL, e = process.env.SUPPORT_EMAIL;\n'
      + 'const t = process.env.SHUTDOWN_TIMEOUT, h = process.env.DB_HOST, f = process.env.FOO;\n');
    fs.writeFileSync(path.join(dir, '.env'),
      'APP_NAME=myapp\nRETRIES=3\nDEBUG=false\nPORT=3000\nAPI_URL=https://example.com\nSUPPORT_EMAIL=a@b.com\nSHUTDOWN_TIMEOUT=15m\nDB_HOST=localhost\nFOO=bar\n');
    const roundTrip = run(['check', dir, '--schema', './env.schema.js']);
    assert.strictEqual(roundTrip.status, 0, roundTrip.stdout + roundTrip.stderr);
    assert.ok(roundTrip.stdout.includes('all clean'), roundTrip.stdout);
    fs.rmSync(path.join(dir, '.env'));

    // A fresh directory (no code yet) behaves exactly as before: the same 8
    // starter keys, no scan comment, and no "folded in" line on stdout.
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-init-fresh-'));
    try {
      const freshInit = run(['init', fresh]);
      assert.strictEqual(freshInit.status, 0, freshInit.stderr);
      assert.ok(freshInit.stdout.includes('(8 variables)'), freshInit.stdout);
      assert.ok(!freshInit.stdout.includes('folded in'), freshInit.stdout);
      const freshSchema = fs.readFileSync(path.join(fresh, 'env.schema.js'), 'utf8');
      assert.doesNotMatch(freshSchema, /Found by scanning/);
      const freshStarter = require(path.join(fresh, 'env.schema.js'));
      assert.deepStrictEqual(
        Object.keys(freshStarter),
        ['APP_NAME', 'RETRIES', 'DEBUG', 'PORT', 'API_URL', 'SUPPORT_EMAIL', 'SHUTDOWN_TIMEOUT', 'DB_HOST'],
      );
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #54: `sensitive: true` masks a key's value in all validation errors
// and CLI output, even when its name does not look like a secret.
{
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');

  // 1. Invalid non-boolean `sensitive` option is rejected up front even when absent.
  for (const bad of ['true', 1, 0, null, {}]) {
    assert.throws(
      () => validateEnv({ SESSION_ID: { type: 'string', sensitive: bad } }, {}),
      err => err instanceof EnvSaafError
        && err.errors.includes('SESSION_ID: "sensitive" must be a boolean'),
    );
  }

  // 2. Coercion errors across types never leak the raw value when sensitive: true.
  const coercionCases = [
    ['email', 'not-an-email-secret99'],
    ['number', 'not-a-number-secret99'],
    ['int', 'not-an-int-secret99'],
    ['json', '{bad-json-secret99'],
    ['boolean', 'not-a-bool-secret99'],
    ['url', 'not-a-url-secret99'],
    ['file', path.join(os.tmpdir(), 'env-saaf-missing-secret-file-99999')],
    ['uuid', 'not-a-uuid-secret99'],
    ['hex', 'not-hex-secret99'],
    ['ipv4', '999.999.999.999'],
    ['semver', 'v-secret-1.2.3'],
    ['base64', 'not*base64*secret99'],
    ['date', 'not-a-date-secret99'],
    ['duration', 'not-a-duration-secret99'],
    ['host', 'https://secret-host.internal/path'],
    ['port', '99999'],
  ];
  for (const [type, raw] of coercionCases) {
    assert.throws(
      () => validateEnv({ SESSION_ID: { type, sensitive: true } }, { SESSION_ID: raw }),
      err => err instanceof EnvSaafError
        && !err.message.includes(raw)
        && err.errors[0].includes(`got "${maskValue(raw)}"`),
      `expected masked error for type "${type}"`,
    );
  }
  // URL protocols mismatch also masks sensitive values.
  const badProtoUrl = 'http://secret-token-host.internal/callback';
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'url', protocols: ['https'], sensitive: true } }, { SESSION_ID: badProtoUrl }),
    err => err instanceof EnvSaafError
      && !err.message.includes(badProtoUrl)
      && err.errors[0].includes(`got "${maskValue(badProtoUrl)}"`),
  );

  // 3. Post-coercion rule checks (min/max, minLength/maxLength, length, choices, pattern, transform).
  assert.throws(
    () => validateEnv({ LICENSE_KEY: { type: 'int', min: 100000, sensitive: true } }, { LICENSE_KEY: '12345' }),
    err => err instanceof EnvSaafError && !err.message.includes('12345') && err.errors[0].includes('got "12***45"'),
  );
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'string', minLength: 30, sensitive: true } }, { SESSION_ID: 'sess_secret_99' }),
    err => err instanceof EnvSaafError && !err.message.includes('sess_secret_99') && err.errors[0].includes('got "se***99"'),
  );
  assert.throws(
    () => validateEnv({ LICENSE_KEY: { type: 'hex', length: 32, sensitive: true } }, { LICENSE_KEY: 'deadbeef1234' }),
    err => err instanceof EnvSaafError && !err.message.includes('deadbeef1234') && err.errors[0].includes('got "de***34"'),
  );
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'string', choices: ['alpha', 'beta'], sensitive: true } }, { SESSION_ID: 'secret_gamma_99' }),
    err => err instanceof EnvSaafError && !err.message.includes('secret_gamma_99') && err.errors[0].includes('got "se***99"'),
  );
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'string', pattern: /^sid_/, sensitive: true } }, { SESSION_ID: 'raw_secret_token_99' }),
    err => err instanceof EnvSaafError && !err.message.includes('raw_secret_token_99') && err.errors[0].includes('got "ra***99"'),
  );
  // Throwing transform that echoes the value still does not leak the raw value.
  assert.throws(
    () => validateEnv(
      { SESSION_ID: { type: 'string', sensitive: true, transform: v => { throw new Error(`bad token ${v}`); } } },
      { SESSION_ID: 'raw_secret_token_99' },
    ),
    err => err instanceof EnvSaafError && !err.message.includes('raw_secret_token_99') && err.errors[0].includes('ra***99'),
  );

  // 4. Short sensitive values mask to '****' without leaking.
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'int', sensitive: true } }, { SESSION_ID: 'bad!' }),
    err => err instanceof EnvSaafError && !err.message.includes('bad!') && err.errors[0].includes('got "****"'),
  );

  // 5. Valid sensitive values return the real unmasked value.
  const okRes = validateEnv(
    { SESSION_ID: { type: 'string', pattern: /^sid_/, sensitive: true } },
    { SESSION_ID: 'sid_real_value_123' },
  );
  assert.strictEqual(okRes.SESSION_ID, 'sid_real_value_123');

  // 6. Non-throwing mode masks sensitive values in errors too.
  const nonThrow = validateEnv(
    { SESSION_ID: { type: 'uuid', sensitive: true } },
    { SESSION_ID: 'sess_raw_secret_42' },
    { throwOnError: false },
  );
  assert.deepStrictEqual(nonThrow.env, {});
  assert.strictEqual(nonThrow.errors.length, 1);
  assert.ok(!nonThrow.errors[0].includes('sess_raw_secret_42'));
  assert.ok(nonThrow.errors[0].includes('got "se***42"'));

  // 7. Non-sensitive control: sensitive omitted or false behaves identically to before.
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'int' } }, { SESSION_ID: 'not-an-int-plain99' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'SESSION_ID: expected an integer (e.g. 42), got "not-an-int-plain99"',
  );
  assert.throws(
    () => validateEnv({ SESSION_ID: { type: 'int', sensitive: false } }, { SESSION_ID: 'not-an-int-plain99' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'SESSION_ID: expected an integer (e.g. 42), got "not-an-int-plain99"',
  );

  // 8. maskSecrets masks innocuously-named keys as well.
  assert.deepStrictEqual(
    maskSecrets({ SESSION_ID: 'sess_raw_secret_42', LICENSE_KEY: 'lic_99887766' }),
    { SESSION_ID: 'se***42', LICENSE_KEY: 'li***66' },
  );

  // 9. generateExample leaves sensitive keys empty (unless default is set),
  // while non-sensitive innocuously-named keys keep their placeholder.
  const exSens = generateExample({
    SESSION_ID: { type: 'string', required: true, sensitive: true },
    PLAIN_ID: { type: 'string', required: true },
    SENS_DEFAULT: { type: 'string', sensitive: true, default: 'dev-placeholder' },
  });
  assert.match(exSens, /^SESSION_ID=$/m);
  assert.match(exSens, /^PLAIN_ID=your_value_here$/m);
  assert.match(exSens, /^SENS_DEFAULT=dev-placeholder$/m);

  // 10. loadEnv and CLI `check --schema` (text and --json) mask sensitive values.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-sensitive-'));
  try {
    const envFile = path.join(dir, '.env');
    const exampleFile = path.join(dir, '.env.example');
    const schemaFile = path.join(dir, 'env.schema.js');
    const secretVal = 'lic_super_secret_987654';
    fs.writeFileSync(envFile, `SESSION_ID=${secretVal}\n`);
    fs.writeFileSync(exampleFile, 'SESSION_ID=\n');
    fs.writeFileSync(path.join(dir, 'app.js'), 'const s = process.env.SESSION_ID;\n');
    fs.writeFileSync(schemaFile, "module.exports = { SESSION_ID: { type: 'uuid', required: true, sensitive: true } };\n");

    assert.throws(
      () => loadEnv({ SESSION_ID: { type: 'uuid', required: true, sensitive: true } }, { path: envFile, env: {} }),
      err => err instanceof EnvSaafError && !err.message.includes(secretVal) && err.errors[0].includes('got "li***54"'),
    );

    const cli = path.join(__dirname, 'cli.js');
    const textRun = spawnSync('node', [cli, 'check', dir, '--schema', './env.schema.js'], { encoding: 'utf8' });
    assert.strictEqual(textRun.status, 1);
    assert.ok(!textRun.stdout.includes(secretVal) && !textRun.stderr.includes(secretVal), textRun.stdout + textRun.stderr);
    assert.ok(textRun.stdout.includes('INVALID: SESSION_ID:') && textRun.stdout.includes('got "li***54"'), textRun.stdout);

    const jsonRun = spawnSync('node', [cli, 'check', dir, '--schema', './env.schema.js', '--json'], { encoding: 'utf8' });
    assert.strictEqual(jsonRun.status, 1);
    assert.ok(!jsonRun.stdout.includes(secretVal) && !jsonRun.stderr.includes(secretVal), jsonRun.stdout + jsonRun.stderr);
    const parsed = JSON.parse(jsonRun.stdout.trim());
    assert.strictEqual(parsed.ok, false);
    assert.ok(parsed.invalid[0].includes('got "li***54"'), parsed.invalid[0]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- requiredIf: conditionally required variables (issue #51) ---
{
  // 1. Up-front schema validation rejects malformed requiredIf specs,
  // even when the key is absent and even in non-throwing mode.
  for (const bad of [
    null,
    'MODE',
    123,
    true,
    [],
    {},
    { key: '' },
    { key: '   ' },
    { key: 42, equals: 'production' },
    { key: 'MODE' },
    { key: 'MODE', equals: undefined },
    { key: 'MODE', equals: 'production', in: ['production'] },
    { key: 'MODE', in: 'production' },
    { key: 'MODE', in: [] },
  ]) {
    assert.throws(
      () => validateEnv({ SENTRY_DSN: { type: 'url', requiredIf: bad } }, {}, { throwOnError: false }),
      err => err instanceof EnvSaafError && err.errors.some(e => e.startsWith('SENTRY_DSN: "requiredIf')),
      `expected schema error for requiredIf=${JSON.stringify(bad)}`,
    );
  }

  // 2. Basic `equals`: missing + condition true throws the usual required error.
  const basicSchema = {
    MODE: { type: 'string', choices: ['development', 'staging', 'production'] },
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
  };
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'production' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  // Empty string is treated as unset, so it also triggers the required error.
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'production', SENTRY_DSN: '' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  // Provided valid value satisfies the condition.
  const prodOk = validateEnv(basicSchema, { MODE: 'production', SENTRY_DSN: 'https://sentry.example.com/1' });
  assert.strictEqual(prodOk.MODE, 'production');
  assert.strictEqual(prodOk.SENTRY_DSN, 'https://sentry.example.com/1');
  // Provided invalid value reports only the type error (no duplicate missing error).
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'production', SENTRY_DSN: 'not-a-url' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0].includes('SENTRY_DSN: expected a valid URL'),
  );
  // Condition false leaves the key optional and omitted.
  const devOk = validateEnv(basicSchema, { MODE: 'development' });
  assert.strictEqual(devOk.MODE, 'development');
  assert.strictEqual('SENTRY_DSN' in devOk, false);
  // Referenced key absent (or empty) leaves the key optional and omitted.
  const absentOk = validateEnv(basicSchema, {});
  assert.strictEqual('SENTRY_DSN' in absentOk, false);
  const emptyRefOk = validateEnv(basicSchema, { MODE: '' });
  assert.strictEqual('SENTRY_DSN' in emptyRefOk, false);
  // Optional key provided while condition is false is still validated.
  const devWithDsn = validateEnv(basicSchema, { MODE: 'development', SENTRY_DSN: 'https://sentry.example.com/dev' });
  assert.strictEqual(devWithDsn.SENTRY_DSN, 'https://sentry.example.com/dev');
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'development', SENTRY_DSN: 'bad-url' }),
    err => err instanceof EnvSaafError && err.errors[0].includes('SENTRY_DSN: expected a valid URL'),
  );

  // 3. `in: [...]` matches any listed value and stays optional otherwise.
  const inSchema = {
    MODE: { type: 'string' },
    ALERT_WEBHOOK: { type: 'url', requiredIf: { key: 'MODE', in: ['staging', 'production'] } },
  };
  for (const mode of ['staging', 'production']) {
    assert.throws(
      () => validateEnv(inSchema, { MODE: mode }),
      err => err instanceof EnvSaafError && err.errors[0] === 'ALERT_WEBHOOK: missing required variable',
    );
  }
  assert.strictEqual('ALERT_WEBHOOK' in validateEnv(inSchema, { MODE: 'development' }), false);
  assert.strictEqual('ALERT_WEBHOOK' in validateEnv(inSchema, {}), false);

  // 4. Two-pass evaluation: key declaration order does not matter, and
  // conditions see coerced values, defaults, and transforms from Pass 1.
  const reversedSchema = {
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
    MODE: { type: 'string', default: 'production' },
  };
  assert.throws(
    () => validateEnv(reversedSchema, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  // Boolean coercion (and falsy `equals: false`).
  const tlsSchema = {
    TLS_CERT: { type: 'string', requiredIf: { key: 'USE_TLS', equals: true } },
    DEV_NOTICE: { type: 'string', requiredIf: { key: 'USE_TLS', equals: false } },
    USE_TLS: { type: 'boolean', default: false },
  };
  assert.throws(
    () => validateEnv(tlsSchema, { USE_TLS: 'yes' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'TLS_CERT: missing required variable',
  );
  assert.throws(
    () => validateEnv(tlsSchema, {}),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'DEV_NOTICE: missing required variable',
  );
  // Numeric coercion with `in`.
  const retrySchema = {
    RETRY_BACKOFF: { type: 'duration', requiredIf: { key: 'RETRIES', in: [1, 2, 3] } },
    RETRIES: { type: 'int' },
  };
  assert.throws(
    () => validateEnv(retrySchema, { RETRIES: '2' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'RETRY_BACKOFF: missing required variable',
  );
  assert.strictEqual('RETRY_BACKOFF' in validateEnv(retrySchema, { RETRIES: '0' }), false);
  // Transform on referenced key is visible in Pass 2.
  const transformSchema = {
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
    MODE: { type: 'string', transform: v => v.toLowerCase() },
  };
  assert.throws(
    () => validateEnv(transformSchema, { MODE: 'PRODUCTION' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  // If the referenced key failed Pass 1 validation, Pass 2 does not emit a spurious error.
  assert.throws(
    () => validateEnv(basicSchema, { MODE: 'invalid' }),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0].includes('MODE: expected one of'),
  );
  // Referenced key outside the schema falls back to raw `env`.
  const externalRefSchema = {
    SENTRY_DSN: { type: 'url', requiredIf: { key: 'NODE_ENV', equals: 'production' } },
  };
  assert.throws(
    () => validateEnv(externalRefSchema, { NODE_ENV: 'production' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'SENTRY_DSN: missing required variable',
  );
  assert.strictEqual('SENTRY_DSN' in validateEnv(externalRefSchema, { NODE_ENV: 'test' }), false);
  assert.strictEqual('SENTRY_DSN' in validateEnv(externalRefSchema, {}), false);

  // 5. Interaction with `default`, `required: true`, `throwOnError: false`, and `loadEnv`.
  const withDefault = validateEnv(
    {
      MODE: { type: 'string', default: 'production' },
      SENTRY_DSN: { type: 'url', default: 'https://sentry.example.com/default', requiredIf: { key: 'MODE', equals: 'production' } },
    },
    {},
  );
  assert.strictEqual(withDefault.SENTRY_DSN, 'https://sentry.example.com/default');

  // Issue #204: combining `required: true` and `requiredIf` is rejected up front
  // as a schema error instead of silently letting `required` win.
  assert.throws(
    () => validateEnv(
      {
        MODE: { type: 'string', default: 'production' },
        SENTRY_DSN: { type: 'url', required: true, requiredIf: { key: 'MODE', equals: 'production' } },
      },
      {},
    ),
    err => err instanceof EnvSaafError && err.errors.length === 1
      && err.errors[0] === 'SENTRY_DSN: "required" and "requiredIf" cannot be used together (use one or the other)',
  );

  // Non-throwing mode collects the conditional required error alongside validated values.
  const collected = validateEnv(
    {
      MODE: { type: 'string', default: 'production' },
      PORT: { type: 'port', default: 3000 },
      SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
    },
    {},
    { throwOnError: false },
  );
  assert.deepStrictEqual(collected.env, { MODE: 'production', PORT: 3000 });
  assert.deepStrictEqual(collected.errors, ['SENTRY_DSN: missing required variable']);

  // loadEnv enforces requiredIf from loaded .env files.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-required-if-'));
  try {
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, 'MODE=production\n');
    assert.throws(
      () => loadEnv(basicSchema, { path: envFile, env: {} }),
      err => err instanceof EnvSaafError && err.errors[0] === 'SENTRY_DSN: missing required variable',
    );
    fs.writeFileSync(envFile, 'MODE=production\nSENTRY_DSN=https://sentry.example.com/live\n');
    const loaded = loadEnv(basicSchema, { path: envFile, env: {} });
    assert.strictEqual(loaded.SENTRY_DSN, 'https://sentry.example.com/live');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}


// Issue #204: `required` + `requiredIf` contradict each other, and a self-referencing `requiredIf` never fires.
{
  // `required: true` together with `requiredIf` is rejected up front —
  // `required` would otherwise silently win and the condition would be dead config.
  assert.throws(
    () => validateEnv(
      {
        MODE: { type: 'string', default: 'dev' },
        SENTRY_DSN: { type: 'url', required: true, requiredIf: { key: 'MODE', equals: 'production' } },
      },
      { MODE: 'dev' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.includes('SENTRY_DSN: "required" and "requiredIf" cannot be used together (use one or the other)'),
  );
  // Schema errors still throw with `{ throwOnError: false }`.
  assert.throws(
    () => validateEnv(
      { SENTRY_DSN: { type: 'url', required: true, requiredIf: { key: 'MODE', equals: 'production' } } },
      {},
      { throwOnError: false },
    ),
    err => err instanceof EnvSaafError,
  );
  // A `requiredIf` naming its own key is rejected up front.
  assert.throws(
    () => validateEnv(
      { MODE: { type: 'string', requiredIf: { key: 'MODE', equals: 'production' } } },
      {},
    ),
    err => err instanceof EnvSaafError
      && err.errors.includes('MODE: "requiredIf" must name a different key, not itself'),
  );
  // A well-formed `requiredIf` still works (regression guard).
  assert.deepStrictEqual(
    validateEnv(
      {
        MODE: { type: 'string', default: 'development' },
        SENTRY_DSN: { type: 'url', requiredIf: { key: 'MODE', equals: 'production' } },
      },
      { MODE: 'development' },
    ),
    { MODE: 'development' },
  );
}

// Issue #46: `array` type — split a delimited string into a typed array.
{
  // 1. Default `of: 'string'` and explicit `of: 'string'`, trimming items by default.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', of: 'string', required: true } }, { TAGS: 'a,b,c' }).TAGS,
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', required: true } }, { TAGS: ' a , b , c ' }).TAGS,
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array' } }, { TAGS: 'solo' }).TAGS,
    ['solo'],
  );
  // trim: false preserves surrounding whitespace on each item.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', of: 'string', trim: false } }, { TAGS: ' a , b ' }).TAGS,
    [' a ', ' b '],
  );

  // 2. Custom separators (single-character and multi-character).
  assert.deepStrictEqual(
    validateEnv({ PORTS: { type: 'array', of: 'port', separator: ';' } }, { PORTS: '80;443;8080' }).PORTS,
    [80, 443, 8080],
  );
  assert.deepStrictEqual(
    validateEnv({ PATHS: { type: 'array', separator: '::' } }, { PATHS: 'alpha::beta::gamma' }).PATHS,
    ['alpha', 'beta', 'gamma'],
  );

  // 3. Coercion across scalar `of` types (number, int, boolean, url + protocols, email, duration, date).
  const typed = validateEnv({
    NUMS: { type: 'array', of: 'number', required: true },
    INTS: { type: 'array', of: 'int', required: true },
    FLAGS: { type: 'array', of: 'boolean', required: true },
    ORIGINS: { type: 'array', of: 'url', protocols: ['https'], required: true },
    EMAILS: { type: 'array', of: 'email', required: true },
    TIMEOUTS: { type: 'array', of: 'duration', required: true },
    DATES: { type: 'array', of: 'date', required: true },
  }, {
    NUMS: '1.5, 2, -3.25',
    INTS: '10, 20, 30',
    FLAGS: 'true, no, 1, off',
    ORIGINS: 'https://a.example.com, https://b.example.com',
    EMAILS: 'admin@example.com, ops@example.com',
    TIMEOUTS: '500ms, 2s, 1m',
    DATES: '2026-01-31, 2026-02-01',
  });
  assert.deepStrictEqual(typed.NUMS, [1.5, 2, -3.25]);
  assert.deepStrictEqual(typed.INTS, [10, 20, 30]);
  assert.deepStrictEqual(typed.FLAGS, [true, false, true, false]);
  assert.deepStrictEqual(typed.ORIGINS, ['https://a.example.com', 'https://b.example.com']);
  assert.deepStrictEqual(typed.EMAILS, ['admin@example.com', 'ops@example.com']);
  assert.deepStrictEqual(typed.TIMEOUTS, [500, 2000, 60000]);
  assert.strictEqual(typed.DATES.length, 2);
  assert.ok(typed.DATES.every(d => d instanceof Date));

  // 4. Invalid items report their 0-based index and offending value.
  assert.throws(
    () => validateEnv({ PORTS: { type: 'array', of: 'port' } }, { PORTS: '80,abc,443' }),
    err => err instanceof EnvSaafError
      && err.errors[0].includes('PORTS[1]')
      && err.errors[0].includes('expected a port')
      && err.errors[0].includes('got "abc"'),
  );
  assert.throws(
    () => validateEnv({ ORIGINS: { type: 'array', of: 'url', protocols: ['https'] } }, { ORIGINS: 'https://a.com,http://b.com' }),
    err => err instanceof EnvSaafError
      && err.errors[0].includes('ORIGINS[1]')
      && err.errors[0].includes('protocols (https)')
      && err.errors[0].includes('got "http://b.com"'),
  );

  // 5. Empty items are rejected (not silently dropped) with their index and value.
  for (const [raw, expectedIndex] of [['a,,c', 1], ['a,   ,c', 1], [',a,b', 0], ['a,b,', 2]]) {
    assert.throws(
      () => validateEnv({ TAGS: { type: 'array', of: 'string' } }, { TAGS: raw }),
      err => err instanceof EnvSaafError
        && err.errors[0].includes(`TAGS[${expectedIndex}]`)
        && err.errors[0].includes('expected a non-empty value'),
    );
  }
  assert.throws(
    () => validateEnv({ INTS: { type: 'array', of: 'int' } }, { INTS: '1,,3' }),
    err => err instanceof EnvSaafError
      && err.errors[0].includes('INTS[1]')
      && err.errors[0].includes('expected an integer')
      && err.errors[0].includes('got ""'),
  );

  // 6. Defaults: delimited string, already-parsed array (including empty []), and invalid defaults.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', default: 'x,y' } }, {}).TAGS,
    ['x', 'y'],
  );
  assert.deepStrictEqual(
    validateEnv({ PORTS: { type: 'array', of: 'port', default: [80, 443] } }, {}).PORTS,
    [80, 443],
  );
  assert.deepStrictEqual(
    validateEnv({ FLAGS: { type: 'array', of: 'string', default: [] } }, {}).FLAGS,
    [],
  );
  assert.throws(
    () => validateEnv({ PORTS: { type: 'array', of: 'port', default: [80, 'bad'] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('PORTS[1]') && err.errors[0].includes('got "bad"'),
  );
  assert.throws(
    () => validateEnv({ NUMS: { type: 'array', of: 'number', default: [1, null] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('NUMS[1]') && err.errors[0].includes('expected a number'),
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', default: 123 } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('expected a delimited list'),
  );

  // 7. Missing optional array is omitted; missing required array fails.
  assert.deepStrictEqual(validateEnv({ TAGS: { type: 'array' } }, {}), {});
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', required: true } }, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: missing required variable',
  );

  // 8. `sensitive: true` masks offending item values without leaking secrets.
  const secretItem = 'secret_bad_token_99';
  assert.throws(
    () => validateEnv(
      { TOKENS: { type: 'array', of: 'uuid', sensitive: true } },
      { TOKENS: `550e8400-e29b-41d4-a716-446655440000,${secretItem}` },
    ),
    err => err instanceof EnvSaafError
      && err.errors[0].includes('TOKENS[1]')
      && !err.message.includes(secretItem)
      && err.errors[0].includes(`got "${maskValue(secretItem)}"`),
  );

  // 9. Up-front schema validation rejects invalid `of` and `separator` even when key is absent.
  for (const badOf of ['unknown', 'array', 123, null, {}]) {
    assert.throws(
      () => validateEnv({ TAGS: { type: 'array', of: badOf } }, {}),
      err => err instanceof EnvSaafError && err.errors[0].includes('TAGS: "of" must be a valid item type'),
    );
  }
  for (const badSep of ['', 123, null, []]) {
    assert.throws(
      () => validateEnv({ TAGS: { type: 'array', separator: badSep } }, {}),
      err => err instanceof EnvSaafError && err.errors[0].includes('TAGS: "separator" must be a non-empty string'),
    );
  }

  // 10. Transform and non-throwing mode work with `array`.
  const transformed = validateEnv(
    { TAGS: { type: 'array', of: 'string', transform: xs => xs.map(s => s.toUpperCase()) } },
    { TAGS: 'a,b' },
  );
  assert.deepStrictEqual(transformed.TAGS, ['A', 'B']);
  const nonThrowArr = validateEnv(
    { PORTS: { type: 'array', of: 'port' }, TAGS: { type: 'array' } },
    { PORTS: '80,nope', TAGS: 'x,y' },
    { throwOnError: false },
  );
  assert.deepStrictEqual(nonThrowArr.env, { TAGS: ['x', 'y'] });
  assert.strictEqual(nonThrowArr.errors.length, 1);
  assert.ok(nonThrowArr.errors[0].includes('PORTS[1]'));

  // 11. `minItems` / `maxItems` bound the item count (issue #207).
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', minItems: 2 } }, { TAGS: 'a,b' }).TAGS,
    ['a', 'b'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', maxItems: 2 } }, { TAGS: 'a,b' }).TAGS,
    ['a', 'b'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', minItems: 2, maxItems: 3 } }, { TAGS: 'a,b,c' }).TAGS,
    ['a', 'b', 'c'],
  );
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', minItems: 1, maxItems: 1 } }, { TAGS: 'solo' }).TAGS,
    ['solo'],
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 2 } }, { TAGS: 'only-one' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected at least 2 items, got 1',
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', maxItems: 2 } }, { TAGS: 'a,b,c' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected at most 2 items, got 3',
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 2, maxItems: 3 } }, { TAGS: 'a,b,c,d' }),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected 2–3 items, got 4',
  );
  // Bounds apply to defaults too, and to an empty array default.
  assert.deepStrictEqual(
    validateEnv({ TAGS: { type: 'array', minItems: 1, maxItems: 2, default: ['x'] } }, {}).TAGS,
    ['x'],
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 2, default: ['x'] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected at least 2 items, got 1',
  );
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 1, default: [] } }, {}),
    err => err instanceof EnvSaafError && err.errors[0] === 'TAGS: expected at least 1 items, got 0',
  );
  // Malformed options are rejected up front, even when the key is absent.
  for (const bad of [{ minItems: -1 }, { maxItems: -2 }, { minItems: 1.5 }, { maxItems: '3' }, { minItems: 3, maxItems: 2 }]) {
    assert.throws(
      () => validateEnv({ TAGS: { type: 'array', ...bad } }, {}),
      err => err instanceof EnvSaafError && err.errors[0].startsWith('TAGS:'),
    );
  }
  assert.throws(
    () => validateEnv({ TAGS: { type: 'array', minItems: 3, maxItems: 2 } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('"minItems" must not exceed "maxItems"'),
  );
  assert.throws(
    () => validateEnv({ NAME: { type: 'string', minItems: 1 } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('"minItems" and "maxItems" only apply to type \'array\''),
  );
  assert.throws(
    () => validateEnv({ N: { type: 'int', maxItems: 2 } }, {}),
    err => err instanceof EnvSaafError && err.errors[0].includes('"minItems" and "maxItems" only apply to type \'array\''),
  );

  // 12. generateExample produces a delimited placeholder (respecting separator, array default, and sensitive).
  const exArr = generateExample({
    TAGS: { type: 'array', required: true },
    PORTS: { type: 'array', of: 'port', separator: ';' },
    DEFAULTS: { type: 'array', of: 'port', separator: ';', default: [80, 443] },
    SECRET_LIST: { type: 'array', sensitive: true },
  });
  assert.match(exArr, /^TAGS=a,b,c$/m);
  // Issue #223: port items get port examples (previously the invalid 'a;b;c').
  assert.match(exArr, /^PORTS=3000;8080;5432$/m);
  assert.match(exArr, /^DEFAULTS=80;443$/m);
  assert.match(exArr, /^SECRET_LIST=$/m);
}
// Issue #205: aliases must not populate multiple declared keys.
{
  const cases = [
    [{ A: { aliases: ['B'] }, B: { type: 'string' } }, 'A', 'B'],
    [{ B: { type: 'string' }, A: { aliases: ['B'] } }, 'A', 'B'],
    [{ A: { aliases: ['SHARED'] }, B: { aliases: ['SHARED'] } }, 'B', 'SHARED'],
    [{ A: { aliases: ['A'] } }, 'A', 'A'],
    [{ A: { aliases: ['__proto__'] }, ['__proto__']: { type: 'string' } }, 'A', '__proto__'],
    [{ A: { aliases: ['toString'] }, B: { aliases: ['toString'] } }, 'B', 'toString'],
  ];
  for (const [schema, key, alias] of cases) {
    for (const throwOnError of [true, false]) {
      assert.throws(
        () => validateEnv(schema, {}, { throwOnError }),
        err => err instanceof EnvSaafError
          && err.errors.some(message => message.startsWith(`${key}:`) && message.includes(`"${alias}"`)),
        `expected alias collision for ${key}/${alias} with throwOnError=${throwOnError}`,
      );
    }
  }
}

// Issue #53: `aliases` accepts renamed/deprecated variables as fallbacks and warns.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { loadEnv } = require('./index');

  // 1. Schema validation rejects malformed `aliases` up front even when absent.
  for (const bad of ['OLD_NAME', 123, null, {}, [''], ['   '], [123], [null], ['OK', '']]) {
    assert.throws(
      () => validateEnv({ DATABASE_URL: { type: 'url', aliases: bad } }, {}),
      err => err instanceof EnvSaafError
        && err.errors.includes('DATABASE_URL: "aliases" must be an array of non-empty strings'),
      `expected schema error for aliases=${JSON.stringify(bad)}`,
    );
  }
  // Empty array is a valid no-op.
  assert.deepStrictEqual(validateEnv({ A: { type: 'string', aliases: [] } }, {}), {});

  // 2. Non-function `onWarn` throws TypeError.
  assert.throws(
    () => validateEnv({ A: { type: 'string', aliases: ['OLD_A'] } }, {}, { onWarn: 'nope' }),
    TypeError,
  );

  // 3. Alias-only config validates, coerces, transforms, and yields under canonical key.
  {
    const warnings = [];
    const res = validateEnv(
      {
        PORT: { type: 'port', required: true, aliases: ['APP_PORT'] },
        ORIGINS: {
          type: 'array',
          aliases: ['CORS_ORIGINS'],
          transform: xs => xs.map(s => s.toLowerCase()),
        },
      },
      { APP_PORT: '8080', CORS_ORIGINS: 'A.COM, B.COM' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.PORT, 8080);
    assert.deepStrictEqual(res.ORIGINS, ['a.com', 'b.com']);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'APP_PORT'), false);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'CORS_ORIGINS'), false);
    assert.deepStrictEqual(warnings, [
      'env-saaf: APP_PORT is deprecated; use PORT instead',
      'env-saaf: CORS_ORIGINS is deprecated; use ORIGINS instead',
    ]);
  }

  // 4. Default warning sink uses console.warn once per warning.
  {
    const origWarn = console.warn;
    const logged = [];
    console.warn = (...args) => logged.push(args.join(' '));
    try {
      const res = validateEnv(
        { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL'] } },
        { DB_URL: 'https://db.example.com' },
      );
      assert.strictEqual(res.DATABASE_URL, 'https://db.example.com');
      assert.deepStrictEqual(logged, ['env-saaf: DB_URL is deprecated; use DATABASE_URL instead']);
    } finally {
      console.warn = origWarn;
    }
  }

  // 5. Both canonical key and alias set: canonical key wins and warning notes alias is ignored.
  {
    const warnings = [];
    const res = validateEnv(
      { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL', 'LEGACY_DB_URL'] } },
      { DATABASE_URL: 'https://new.example.com', DB_URL: 'https://old.example.com' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.DATABASE_URL, 'https://new.example.com');
    assert.deepStrictEqual(warnings, ['env-saaf: DB_URL is ignored because DATABASE_URL is set']);
  }

  // 6. Only canonical key set: no warnings.
  {
    const warnings = [];
    const res = validateEnv(
      { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL'] } },
      { DATABASE_URL: 'https://new.example.com' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.DATABASE_URL, 'https://new.example.com');
    assert.deepStrictEqual(warnings, []);
  }

  // 7. Multiple aliases: first populated alias wins, subsequent populated aliases warn as ignored.
  {
    const warnings = [];
    const res = validateEnv(
      { PORT: { type: 'port', aliases: ['OLD_PORT_1', 'OLD_PORT_2', 'OLD_PORT_3'] } },
      { OLD_PORT_1: '', OLD_PORT_2: '4000', OLD_PORT_3: '5000' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.PORT, 4000);
    assert.deepStrictEqual(warnings, [
      'env-saaf: OLD_PORT_2 is deprecated; use PORT instead',
      'env-saaf: OLD_PORT_3 is ignored because OLD_PORT_2 is set; use PORT instead',
    ]);
  }

  // 8. Empty canonical key ('') falls back to alias; empty alias ('') is treated as unset.
  {
    const warnings = [];
    const res = validateEnv(
      {
        HOST: { type: 'host', aliases: ['APP_HOST'] },
        MODE: { type: 'string', default: 'dev', aliases: ['APP_MODE'] },
      },
      { HOST: '', APP_HOST: 'localhost', APP_MODE: '' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.HOST, 'localhost');
    assert.strictEqual(res.MODE, 'dev');
    assert.deepStrictEqual(warnings, ['env-saaf: APP_HOST is deprecated; use HOST instead']);
  }

  // 9. Alias wins over default; missing canonical + alias still fails required without warning.
  {
    const warnings = [];
    const res = validateEnv(
      { PORT: { type: 'port', default: 3000, aliases: ['APP_PORT'] } },
      { APP_PORT: '9000' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.PORT, 9000);
    assert.strictEqual(warnings.length, 1);

    const reqWarnings = [];
    assert.throws(
      () => validateEnv(
        { PORT: { type: 'port', required: true, aliases: ['APP_PORT'] } },
        {},
        { onWarn: msg => reqWarnings.push(msg) },
      ),
      err => err instanceof EnvSaafError && err.errors.includes('PORT: missing required variable'),
    );
    assert.deepStrictEqual(reqWarnings, []);
  }

  // 10. Invalid alias value reports error under canonical key and respects `sensitive: true`.
  {
    const warnings = [];
    assert.throws(
      () => validateEnv(
        { SESSION_ID: { type: 'uuid', sensitive: true, aliases: ['OLD_SESSION_ID'] } },
        { OLD_SESSION_ID: 'not-a-uuid-secret99' },
        { onWarn: msg => warnings.push(msg) },
      ),
      err => err instanceof EnvSaafError
        && !err.message.includes('not-a-uuid-secret99')
        && err.errors[0].startsWith('SESSION_ID:')
        && err.errors[0].includes('got "no***99"'),
    );
    assert.deepStrictEqual(warnings, ['env-saaf: OLD_SESSION_ID is deprecated; use SESSION_ID instead']);
  }

  // 11. Strict mode recognises declared aliases and still flags unknown variables.
  {
    const warnings = [];
    const okStrict = validateEnv(
      { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL'] } },
      { DB_URL: 'https://db.example.com' },
      { strict: true, onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(okStrict.DATABASE_URL, 'https://db.example.com');
    assert.strictEqual(warnings.length, 1);

    assert.throws(
      () => validateEnv(
        { DATABASE_URL: { type: 'url', required: true, aliases: ['DB_URL'] } },
        { DB_URL: 'https://db.example.com', TYPO_KEY: '1' },
        { strict: true, onWarn: () => {} },
      ),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0] === 'TYPO_KEY: set but not in schema (strict mode)',
    );
  }

  // 12. Repeating an alias on the same rule does not emit duplicate warnings.
  {
    const warnings = [];
    const res = validateEnv(
      { PORT: { type: 'port', aliases: ['APP_PORT', 'APP_PORT'] } },
      { PORT: '3000', APP_PORT: '4000' },
      { onWarn: msg => warnings.push(msg) },
    );
    assert.strictEqual(res.PORT, 3000);
    assert.deepStrictEqual(warnings, ['env-saaf: APP_PORT is ignored because PORT is set']);
  }

  // 13. Non-throwing mode preserves `{ env, errors }` shape and emits warnings via `onWarn`.
  {
    const warnings = [];
    const collected = validateEnv(
      { PORT: { type: 'port', required: true, aliases: ['APP_PORT'] } },
      { APP_PORT: '3000' },
      { throwOnError: false, onWarn: msg => warnings.push(msg) },
    );
    assert.deepStrictEqual(collected, { env: { PORT: 3000 }, errors: [] });
    assert.deepStrictEqual(warnings, ['env-saaf: APP_PORT is deprecated; use PORT instead']);
  }

  // 14. loadEnv passes `onWarn` through and resolves aliases from a `.env` file.
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-aliases-'));
    try {
      const envFile = path.join(dir, '.env');
      fs.writeFileSync(envFile, 'OLD_PORT=7070\n');
      const warnings = [];
      const res = loadEnv(
        { PORT: { type: 'port', required: true, aliases: ['OLD_PORT'] } },
        { path: envFile, env: {}, onWarn: msg => warnings.push(msg) },
      );
      assert.strictEqual(res.PORT, 7070);
      assert.deepStrictEqual(warnings, ['env-saaf: OLD_PORT is deprecated; use PORT instead']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
// Issue #186: validateEnv treats an empty string ('') as unset across
// optional, required, and default rules, while whitespace-only input is provided.
{
  const optional = validateEnv({ NICK: { type: 'string' } }, { NICK: '' });
  assert.deepStrictEqual(optional, {});
  assert.strictEqual(Object.prototype.hasOwnProperty.call(optional, 'NICK'), false);

  assert.throws(
    () => validateEnv({ PORT: { type: 'port', required: true } }, { PORT: '' }),
    err => err instanceof EnvSaafError && err.errors.length === 1 && err.errors[0] === 'PORT: missing required variable',
  );

  const defaulted = validateEnv(
    {
      HOST: { type: 'string', default: 'localhost' },
      PORT: { type: 'port', required: true, default: 3000 },
    },
    { HOST: '', PORT: '' },
  );
  assert.deepStrictEqual(defaulted, { HOST: 'localhost', PORT: 3000 });

  // Whitespace-only is provided, not unset: trimmed to '' by default, preserved with trim: false.
  assert.deepStrictEqual(validateEnv({ NICK: { type: 'string' } }, { NICK: '   ' }), { NICK: '' });
  assert.deepStrictEqual(validateEnv({ NICK: { type: 'string', trim: false } }, { NICK: '   ' }), { NICK: '   ' });

  // parseEnvFile preserves KEY= as '', which validateEnv then treats as unset.
  const parsed = parseEnvFile('NICK=\n');
  assert.deepStrictEqual(parsed, { NICK: '' });
  assert.deepStrictEqual(validateEnv({ NICK: { type: 'string' } }, parsed), {});
}

// Issue #52: per-key `validate(value, env)` function for custom rules.
{
  // 1. Non-function `validate` is rejected up front in validateSchema,
  // even when the key is absent/optional and even with throwOnError: false.
  for (const bad of ['fn', 123, true, null, {}]) {
    assert.throws(
      () => validateEnv({ CUSTOM: { type: 'string', validate: bad } }, {}),
      err => err instanceof EnvSaafError
        && err.errors.includes('CUSTOM: "validate" must be a function'),
    );
    assert.throws(
      () => validateEnv({ CUSTOM: { type: 'string', validate: bad } }, {}, { throwOnError: false }),
      err => err instanceof EnvSaafError
        && err.errors.includes('CUSTOM: "validate" must be a function'),
    );
  }

  // 2. Passing return values: true, undefined, null, and empty string.
  const passRes = validateEnv(
    {
      A: { type: 'string', validate: () => true },
      B: { type: 'string', validate: () => undefined },
      C: { type: 'string', validate: () => null },
      D: { type: 'string', validate: () => '' },
    },
    { A: 'a', B: 'b', C: 'c', D: 'd' },
  );
  assert.deepStrictEqual(passRes, { A: 'a', B: 'b', C: 'c', D: 'd' });

  // 3. Failing return values: string message and boolean false.
  assert.throws(
    () => validateEnv(
      { APP_PORT: { type: 'port', validate: v => v >= 1024 || 'must be an unprivileged port (>= 1024)' } },
      { APP_PORT: '80' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0] === 'APP_PORT: must be an unprivileged port (>= 1024)',
  );
  assert.throws(
    () => validateEnv(
      { APP_PORT: { type: 'port', validate: v => v >= 1024 } },
      { APP_PORT: '80' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0] === 'APP_PORT: failed custom validation, got "80"',
  );

  // 4. Receives coerced value and full env object (cross-key checks).
  let seenVal, seenEnv;
  const inputEnv = { PRIMARY_HOST: 'db1.internal', REPLICA_HOST: 'db2.internal', CONFIG: '{"retries":3}' };
  const crossOk = validateEnv(
    {
      PRIMARY_HOST: { type: 'host', required: true },
      REPLICA_HOST: {
        type: 'host',
        required: true,
        validate: (v, e) => v !== e.PRIMARY_HOST || 'must differ from PRIMARY_HOST',
      },
      CONFIG: {
        type: 'json',
        validate: (v, e) => { seenVal = v; seenEnv = e; return v.retries > 0 || 'retries must be positive'; },
      },
    },
    inputEnv,
  );
  assert.strictEqual(crossOk.REPLICA_HOST, 'db2.internal');
  assert.deepStrictEqual(seenVal, { retries: 3 });
  assert.strictEqual(seenEnv, inputEnv);

  assert.throws(
    () => validateEnv(
      {
        PRIMARY_HOST: { type: 'host', required: true },
        REPLICA_HOST: {
          type: 'host',
          required: true,
          validate: (v, e) => v !== e.PRIMARY_HOST || 'must differ from PRIMARY_HOST',
        },
      },
      { PRIMARY_HOST: 'db1.internal', REPLICA_HOST: 'db1.internal' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0] === 'REPLICA_HOST: must differ from PRIMARY_HOST',
  );

  // 5. Throwing validator is reported as a validation failure, not a crash.
  assert.throws(
    () => validateEnv(
      {
        DIR: { type: 'string', validate: () => { throw new Error('directory does not exist'); } },
        NON_ERR: { type: 'string', validate: () => { throw 'raw string throw'; } },
      },
      { DIR: '/nope', NON_ERR: 'x' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 2
      && err.errors[0] === 'DIR: validation failed: directory does not exist'
      && err.errors[1] === 'NON_ERR: validation failed: raw string throw',
  );

  // 6. Aggregated errors: built-in failures and custom validate failures collect together.
  assert.throws(
    () => validateEnv(
      {
        REQ: { type: 'string', required: true },
        BAD_PORT: { type: 'port' },
        CUSTOM_STR: { type: 'string', validate: () => 'custom reason' },
        CUSTOM_FALSE: { type: 'int', validate: () => false },
        CUSTOM_THROW: { type: 'string', validate: () => { throw new Error('boom'); } },
      },
      { BAD_PORT: 'nope', CUSTOM_STR: 'a', CUSTOM_FALSE: '7', CUSTOM_THROW: 'b' },
    ),
    err => err instanceof EnvSaafError
      && err.errors.length === 5
      && err.errors[0] === 'REQ: missing required variable'
      && err.errors[1].startsWith('BAD_PORT: expected a port')
      && err.errors[2] === 'CUSTOM_STR: custom reason'
      && err.errors[3] === 'CUSTOM_FALSE: failed custom validation, got "7"'
      && err.errors[4] === 'CUSTOM_THROW: validation failed: boom',
  );

  // 7. Execution order:
  // - skipped for missing optional keys and when coercion/built-in checks fail
  // - runs before transform; transform is skipped when validate fails
  // - runs on defaults (while transform is still skipped on defaults)
  let calledOnMissing = false;
  let calledAfterBadCoercion = false;
  let calledAfterBadBuiltin = false;
  validateEnv(
    { OPT: { type: 'string', validate: () => { calledOnMissing = true; return true; } } },
    {},
  );
  assert.strictEqual(calledOnMissing, false);

  assert.throws(
    () => validateEnv(
      {
        N: { type: 'int', validate: () => { calledAfterBadCoercion = true; return true; } },
        M: { type: 'int', min: 10, validate: () => { calledAfterBadBuiltin = true; return true; } },
      },
      { N: 'abc', M: '5' },
    ),
    err => err instanceof EnvSaafError && err.errors.length === 2,
  );
  assert.strictEqual(calledAfterBadCoercion, false);
  assert.strictEqual(calledAfterBadBuiltin, false);

  const order = [];
  const transformedRes = validateEnv(
    {
      LIST: {
        type: 'array',
        validate: xs => { order.push(['validate', xs]); return xs.length >= 2 || 'needs two'; },
        transform: xs => { order.push(['transform', xs]); return xs.map(s => s.toUpperCase()); },
      },
    },
    { LIST: 'a,b' },
  );
  assert.deepStrictEqual(transformedRes.LIST, ['A', 'B']);
  assert.deepStrictEqual(order, [['validate', ['a', 'b']], ['transform', ['a', 'b']]]);

  let transformCalledAfterFail = false;
  assert.throws(
    () => validateEnv(
      {
        LIST: {
          type: 'string',
          validate: () => 'bad list',
          transform: v => { transformCalledAfterFail = true; return v.toUpperCase(); },
        },
      },
      { LIST: 'a' },
    ),
    err => err instanceof EnvSaafError && err.errors[0] === 'LIST: bad list',
  );
  assert.strictEqual(transformCalledAfterFail, false);

  let defaultTransformCalled = false;
  const defaultOk = validateEnv(
    {
      PORT: {
        type: 'port',
        default: 8080,
        validate: v => v >= 1024 || 'too low',
        transform: v => { defaultTransformCalled = true; return v; },
      },
    },
    {},
  );
  assert.strictEqual(defaultOk.PORT, 8080);
  assert.strictEqual(defaultTransformCalled, false);

  assert.throws(
    () => validateEnv(
      { PORT: { type: 'port', default: 80, validate: v => v >= 1024 || 'default too low' } },
      {},
    ),
    err => err instanceof EnvSaafError && err.errors[0] === 'PORT: default too low',
  );

  // 8. `sensitive: true` masks values across false, string, and thrown validate errors.
  const secret = 'sess_secret_token_99';
  assert.throws(
    () => validateEnv(
      { SESSION_ID: { type: 'string', sensitive: true, validate: () => false } },
      { SESSION_ID: secret },
    ),
    err => err instanceof EnvSaafError
      && !err.message.includes(secret)
      && err.errors[0] === `SESSION_ID: failed custom validation, got "${maskValue(secret)}"`,
  );
  assert.throws(
    () => validateEnv(
      { SESSION_ID: { type: 'string', sensitive: true, validate: v => `rejected ${v}` } },
      { SESSION_ID: secret },
    ),
    err => err instanceof EnvSaafError
      && !err.message.includes(secret)
      && err.errors[0] === `SESSION_ID: rejected ${maskValue(secret)}`,
  );
  assert.throws(
    () => validateEnv(
      { SESSION_ID: { type: 'string', sensitive: true, validate: v => { throw new Error(`bad ${v}`); } } },
      { SESSION_ID: secret },
    ),
    err => err instanceof EnvSaafError
      && !err.message.includes(secret)
      && err.errors[0] === `SESSION_ID: validation failed: bad ${maskValue(secret)}`,
  );

  // 9. Non-throwing mode collects validate errors and omits failing keys from env.
  const collected = validateEnv(
    {
      GOOD: { type: 'int', validate: v => v > 0 },
      BAD: { type: 'int', validate: v => v > 10 || 'must exceed 10' },
    },
    { GOOD: '5', BAD: '3' },
    { throwOnError: false },
  );
  assert.deepStrictEqual(collected.env, { GOOD: 5 });
  assert.deepStrictEqual(collected.errors, ['BAD: must exceed 10']);
}

// Issue #210: post-transform return value is verified against the declared type.
{
  const { validateEnv, EnvSaafError, maskValue } = require('./index');

  // 1. Acceptance criteria: int transform returning string, string/omitted-type returning number.
  assert.throws(
    () => validateEnv({ N: { type: 'int', transform: () => 'oops' } }, { N: '5' }),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0].includes('N:')
      && err.errors[0].includes('integer'),
  );
  assert.throws(
    () => validateEnv({ A: { type: 'string', transform: () => 42 } }, { A: 'x' }),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0].includes('A:')
      && err.errors[0].includes('string'),
  );
  assert.throws(
    () => validateEnv({ A: { transform: () => 42 } }, { A: 'x' }),
    err => err instanceof EnvSaafError
      && err.errors.length === 1
      && err.errors[0].includes('A:')
      && err.errors[0].includes('string'),
  );

  // 2. Transforms returning valid values of the declared type pass unchanged
  // (and post-transform values do not re-run choices/min/max/pattern).
  const fixedDate = new Date('2026-06-01T00:00:00Z');
  const valid = validateEnv(
    {
      S: { type: 'string', choices: ['a', 'b'], transform: v => v.toUpperCase() },
      N: { type: 'number', min: 1, max: 10, transform: n => n * 10.5 },
      I: { type: 'int', transform: n => n + 1 },
      P: { type: 'port', transform: n => n + 1 },
      D: { type: 'duration', transform: ms => ms * 2 },
      B: { type: 'boolean', transform: b => !b },
      DT: { type: 'date', transform: () => fixedDate },
      J: { type: 'json', transform: v => ({ wrapped: v }) },
      J_NULL: { type: 'json', transform: () => null },
      ARR: { type: 'array', of: 'int', transform: xs => xs.map(x => x * 2) },
      EMAIL: { type: 'email', transform: v => v.toLowerCase() },
      URL: { type: 'url', protocols: ['https'], transform: v => v.replace(/\/$/, '') },
    },
    {
      S: 'a',
      N: '2',
      I: '4',
      P: '3000',
      D: '1s',
      B: 'true',
      DT: '2026-01-31',
      J: '{"k":1}',
      J_NULL: '123',
      ARR: '1,2,3',
      EMAIL: 'USER@EXAMPLE.COM',
      URL: 'https://example.com/',
    },
  );
  assert.strictEqual(valid.S, 'A');
  assert.strictEqual(valid.N, 21);
  assert.strictEqual(valid.I, 5);
  assert.strictEqual(valid.P, 3001);
  assert.strictEqual(valid.D, 2000);
  assert.strictEqual(valid.B, false);
  assert.strictEqual(valid.DT, fixedDate);
  assert.deepStrictEqual(valid.J, { wrapped: { k: 1 } });
  assert.strictEqual(valid.J_NULL, null);
  assert.deepStrictEqual(valid.ARR, [2, 4, 6]);
  assert.strictEqual(valid.EMAIL, 'user@example.com');
  assert.strictEqual(valid.URL, 'https://example.com');

  // 3. Invalid post-transform values are rejected across all type categories.
  const badCases = [
    [{ N: { type: 'number', transform: () => NaN } }, { N: '1' }, /N: expected a number/],
    [{ N: { type: 'number', transform: () => Infinity } }, { N: '1' }, /N: expected a number/],
    [{ N: { type: 'number', transform: () => '5' } }, { N: '1' }, /N: expected a number/],
    [{ I: { type: 'int', transform: () => 3.5 } }, { I: '1' }, /I: expected an integer/],
    [{ I: { type: 'int', transform: () => '5' } }, { I: '1' }, /I: expected an integer/],
    [{ P: { type: 'port', transform: () => 70000 } }, { P: '3000' }, /P: expected a port/],
    [{ P: { type: 'port', transform: () => '3000' } }, { P: '3000' }, /P: expected a port/],
    [{ D: { type: 'duration', transform: () => -5 } }, { D: '1s' }, /D: expected a duration/],
    [{ D: { type: 'duration', transform: () => '1s' } }, { D: '1s' }, /D: expected a duration/],
    [{ B: { type: 'boolean', transform: () => 'true' } }, { B: 'true' }, /B: expected a boolean/],
    [{ B: { type: 'boolean', transform: () => 1 } }, { B: 'true' }, /B: expected a boolean/],
    [{ DT: { type: 'date', transform: () => '2026-01-31' } }, { DT: '2026-01-31' }, /DT: expected a valid ISO 8601 date/],
    [{ DT: { type: 'date', transform: () => new Date('invalid') } }, { DT: '2026-01-31' }, /DT: expected a valid ISO 8601 date/],
    [{ J: { type: 'json', transform: () => undefined } }, { J: '{}' }, /J: expected valid JSON/],
    [{ J: { type: 'json', transform: () => NaN } }, { J: '{}' }, /J: expected valid JSON/],
    [{ L: { type: 'array', transform: () => 'a,b' } }, { L: 'a,b' }, /L: expected an array/],
    [{ L: { type: 'array', of: 'int', transform: xs => [...xs, 'oops'] } }, { L: '1,2' }, /L\[2\]: expected an integer/],
    [{ L: { type: 'array', of: 'url', protocols: ['https'], transform: () => ['http://example.com'] } }, { L: 'https://example.com' }, /L\[0\]: expected a URL with one of these protocols/],
    [{ E: { type: 'email', transform: () => 42 } }, { E: 'a@b.co' }, /E: expected a email string/],
    [{ E: { type: 'email', transform: () => 'not-an-email' } }, { E: 'a@b.co' }, /E: expected a valid email address/],
    [{ H: { type: 'hex', transform: () => 1234 } }, { H: 'deadbeef' }, /H: expected a hex string/],
    [{ U: { type: 'url', protocols: ['https'], transform: () => 'http://example.com' } }, { U: 'https://example.com' }, /U: expected a URL with one of these protocols/],
    [{ NUL: { type: 'string', transform: () => Object.create(null) } }, { NUL: 'x' }, /NUL: expected a string/],
  ];
  for (const [schema, envInput, pattern] of badCases) {
    assert.throws(() => validateEnv(schema, envInput), pattern);
  }

  // 4. `default` + `transform`: bad defaults fail type validation even with transform;
  // valid defaults do not invoke transform and pass unchanged.
  assert.throws(
    () => validateEnv({ N: { type: 'int', default: 'oops', transform: x => x + 1 } }, {}),
    /N: expected an integer/,
  );
  assert.throws(
    () => validateEnv({ N: { type: 'int', default: 'oops', transform: x => x + 1 } }, { N: '' }),
    /N: expected an integer/,
  );
  let defaultRanTransform = false;
  assert.strictEqual(
    validateEnv({ N: { type: 'int', default: 5, transform: () => { defaultRanTransform = true; return 'oops'; } } }, {}).N,
    5,
  );
  assert.strictEqual(defaultRanTransform, false);

  // 5. Execution order, non-throwing mode, Pass 2 requiredIf, aliases, and sensitive masking.
  let seenByValidate;
  assert.throws(
    () => validateEnv(
      {
        N: {
          type: 'int',
          validate: v => { seenByValidate = v; return true; },
          transform: () => 'oops',
        },
      },
      { N: '5' },
    ),
    /N: expected an integer/,
  );
  assert.strictEqual(seenByValidate, 5);

  const nonThrowing = validateEnv(
    {
      GOOD: { type: 'int', transform: n => n + 1 },
      BAD: { type: 'int', transform: () => 'oops' },
      DEP: { type: 'string', requiredIf: { key: 'BAD', equals: 'oops' } },
    },
    { GOOD: '1', BAD: '5' },
    { throwOnError: false },
  );
  assert.deepStrictEqual(nonThrowing.env, { GOOD: 2 });
  assert.strictEqual(nonThrowing.errors.length, 1);
  assert.ok(nonThrowing.errors[0].includes('BAD: expected an integer'));

  const aliasWarnings = [];
  assert.throws(
    () => validateEnv(
      { N: { type: 'int', aliases: ['OLD_N'], transform: () => 'oops' } },
      { OLD_N: '5' },
      { onWarn: m => aliasWarnings.push(m) },
    ),
    /N: expected an integer/,
  );
  assert.strictEqual(aliasWarnings.length, 1);

  const rawSecret = 'super_secret_token_99';
  assert.throws(
    () => validateEnv(
      { TOK: { type: 'int', sensitive: true, transform: () => rawSecret } },
      { TOK: '7' },
    ),
    err => err instanceof EnvSaafError
      && !err.message.includes(rawSecret)
      && err.errors[0].includes(maskValue(rawSecret)),
  );
}

// Issue #211: string-only options (`pattern`, `minLength`, `maxLength`) must be
// rejected up front on non-string types instead of silently doing nothing.
{
  const fs = require('node:fs');
  const path = require('node:path');

  // Exact reproduction from issue #211 (present and absent, throwing and non-throwing).
  for (const env of [{ N: '42' }, {}]) {
    assert.throws(
      () => validateEnv({ N: { type: 'int', pattern: /^4/ } }, env),
      err => err instanceof EnvSaafError
        && err.errors.length === 1
        && err.errors[0].includes('N:')
        && err.errors[0].includes('"pattern"'),
    );
  }
  assert.throws(
    () => validateEnv({ N: { type: 'int', pattern: /^4/ } }, {}, { throwOnError: false }),
    err => err instanceof EnvSaafError && err.errors[0].includes('N:') && err.errors[0].includes('"pattern"'),
  );

  // Every non-string type rejects pattern, minLength, and maxLength up front.
  const nonStringCases = [
    ['int', { N: '42' }],
    ['number', { N: '3.14' }],
    ['port', { N: '3000' }],
    ['duration', { N: '15m' }],
    ['boolean', { N: 'true' }],
    ['date', { N: '2026-01-31' }],
    ['array', { N: 'a,b' }],
    ['json', { N: '{"a":1}' }],
  ];
  for (const [type, env] of nonStringCases) {
    for (const [opt, val] of [['pattern', /^a/], ['minLength', 1], ['maxLength', 5]]) {
      for (const inputEnv of [env, {}]) {
        assert.throws(
          () => validateEnv({ K: { type, [opt]: val } }, inputEnv),
          err => err instanceof EnvSaafError
            && err.errors.some(e => e.includes('K:') && e.includes(`"${opt}"`) && e.includes(`'${type}'`)),
          `expected ${type} to reject ${opt}`,
        );
      }
    }
  }

  // Omitted type defaults to 'string' and all string-valued types keep working.
  assert.strictEqual(
    validateEnv({ S: { pattern: /^[a-z]+$/, minLength: 2, maxLength: 5 } }, { S: 'abc' }).S,
    'abc',
  );
  const tmpDir = fs.mkdtempSync(path.join(__dirname, 'issue-211-test-'));
  const tmpFile = path.join(tmpDir, 'sample.txt');
  fs.writeFileSync(tmpFile, 'ok');
  try {
    const stringCases = [
      ['string', 'hello', /^h/, 2, 10],
      ['email', 'user@example.com', /@example\.com$/, 5, 30],
      ['url', 'https://example.com', /^https:\/\//, 10, 40],
      ['file', tmpFile, /sample\.txt$/, 5, 300],
      ['uuid', '550e8400-e29b-41d4-a716-446655440000', /^550e8400-/, 36, 36],
      ['hex', 'deadbeef', /^dead/, 4, 16],
      ['ipv4', '192.168.0.1', /^192\.168\./, 7, 15],
      ['semver', '1.2.3-beta.1', /^1\.2\.3/, 5, 20],
      ['base64', 'aGVsbG8=', /^aGVs/, 4, 16],
      ['host', 'db.internal', /\.internal$/, 3, 30],
    ];
    for (const [type, raw, pattern, minLength, maxLength] of stringCases) {
      assert.strictEqual(
        validateEnv({ S: { type, pattern, minLength, maxLength } }, { S: raw }).S,
        raw,
        `expected ${type} to allow pattern/minLength/maxLength`,
      );
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Numeric min/max bounds continue working on numeric types.
  assert.strictEqual(validateEnv({ N: { type: 'int', min: 1, max: 50 } }, { N: '42' }).N, 42);

  // Unknown type with string-only option reports only the unknown type error.
  assert.throws(
    () => validateEnv({ K: { type: 'emial', pattern: /@/ } }, {}),
    err => err instanceof EnvSaafError && err.errors.length === 1 && err.errors[0].includes('unknown type "emial"'),
  );
  // Unknown option on a present environment variable.
  assert.throws(
    () => validateEnv({ PORT: { type: 'port', requried: true } }, { PORT: '3000' }),
    err => err instanceof EnvSaafError
      && err.errors.includes('PORT: unknown option "requried"'),
  );

  // Unknown option on an absent environment variable.
  // Schema errors must throw even when throwOnError is false.
  assert.throws(
    () => validateEnv({ PORT: { type: 'port', requried: true } }, {}, { throwOnError: false }),
    err => err instanceof EnvSaafError
      && err.errors.includes('PORT: unknown option "requried"'),
  );

  // Misspelled default must also be rejected.
  assert.throws(
    () => validateEnv({ PORT: { type: 'port', defualt: '3000' } }, {}),
    err => err instanceof EnvSaafError
      && err.errors.includes('PORT: unknown option "defualt"'),
  );

  // Issue #250: a typo'd option on the options object itself is rejected up
  // front — same class of bug as #218, one layer up.
  assert.throws(
    () => validateEnv({ A: { type: 'string' } }, { A: 'x', TYPO_KEY: '1' }, { stric: true }),
    err => err instanceof EnvSaafError
      && err.errors.some((e) => e.includes('unknown option "stric"')),
  );
  assert.throws(
    () => validateEnv({ A: { type: 'string' } }, { A: 'x' }, { throwOnEror: true }),
    err => err instanceof EnvSaafError
      && err.errors.some((e) => e.includes('unknown option "throwOnEror"')),
  );
  // The check runs even when the variable is absent and even with
  // { throwOnError: false } — like schema errors, it always throws.
  assert.throws(
    () => validateEnv({ A: { type: 'string' } }, {}, { stric: true, throwOnError: false }),
    err => err instanceof EnvSaafError
      && err.errors.some((e) => e.includes('unknown option "stric"')),
  );
  // loadEnv rejects its own typos too, naming the loadEnv option set.
  const tmp250 = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'env-saaf-250-'));
  try {
    assert.throws(
      () => loadEnv({ A: { type: 'string' } }, { path: require('node:path').join(tmp250, 'x.env'), env: { A: 'x' }, overide: true }),
      err => err instanceof EnvSaafError
        && err.errors.some((e) => e.includes('unknown option "overide"')),
    );
    // A typo'd validateEnv option forwarded through loadEnv is rejected too.
    assert.throws(
      () => loadEnv({ A: { type: 'string' } }, { path: require('node:path').join(tmp250, 'x.env'), env: { A: 'x' }, stric: true }),
      err => err instanceof EnvSaafError
        && err.errors.some((e) => e.includes('unknown option "stric"')),
    );
  } finally {
    require('node:fs').rmSync(tmp250, { recursive: true, force: true });
  }
  // Every currently valid option keeps working exactly as before.
  assert.deepStrictEqual(
    validateEnv({ A: { type: 'string' } }, { A: 'x', B: '1' }, { strict: true, throwOnError: false }).errors,
    ['B: set but not in schema (strict mode)'],
  );
  assert.strictEqual(validateEnv({ A: { type: 'string' } }, { A: 'x' }, { throwOnError: false }).env.A, 'x');
  assert.throws(
    () => validateEnv({ A: { type: 'string', required: true } }, {}, { formatError: () => 'custom' }),
    (e) => e.message === 'custom',
  );

  // Issue #220: contradictory bounds are schema errors, even for absent keys.
  assert.throws(
    () => validateEnv({ N: { type: 'number', min: 10, max: 5 } }, { N: '7' }),
    err => err instanceof EnvSaafError && err.errors.includes('N: "min" must not exceed "max"'),
  );
  assert.throws(
    () => validateEnv({ N: { type: 'number', min: 10, max: 5 } }, {}),
    err => err instanceof EnvSaafError && err.errors.includes('N: "min" must not exceed "max"'),
  );
  assert.throws(
    () => validateEnv({ S: { type: 'string', minLength: 10, maxLength: 5 } }, { S: 'hello' }),
    err => err instanceof EnvSaafError && err.errors.includes('S: "minLength" must not exceed "maxLength"'),
  );
  assert.throws(
    () => validateEnv({ S: { type: 'string', minLength: 10, maxLength: 5 } }, {}),
    err => err instanceof EnvSaafError && err.errors.includes('S: "minLength" must not exceed "maxLength"'),
  );
  assert.throws(
    () => validateEnv({ M: { type: 'string', choices: [] } }, { M: 'a' }),
    err => err instanceof EnvSaafError && err.errors.includes('M: "choices" must be a non-empty array'),
  );
  assert.throws(
    () => validateEnv({ M: { type: 'string', choices: [] } }, {}),
    err => err instanceof EnvSaafError && err.errors.includes('M: "choices" must be a non-empty array'),
  );
  // Valid combinations keep working exactly as before.
  assert.strictEqual(validateEnv({ N: { type: 'number', min: 5, max: 10 } }, { N: '7' }).N, 7);
  assert.strictEqual(validateEnv({ N: { type: 'number', min: 5, max: 5 } }, { N: '5' }).N, 5);
  assert.strictEqual(validateEnv({ S: { type: 'string', minLength: 2, maxLength: 5 } }, { S: 'hey' }).S, 'hey');
  assert.strictEqual(validateEnv({ M: { type: 'string', choices: ['a', 'b'] } }, { M: 'a' }).M, 'a');

  // Several valid options together must continue working.
  assert.strictEqual(
    validateEnv(
      { PORT: { type: 'int', required: true, min: 1, max: 65535, trim: true } },
      { PORT: '3000' },
    ).PORT,
    3000,
  );
}

// feat: grouped (nested) schemas with a key prefix (fixes #228)
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { validateEnv, validateSchema, loadEnv, generateExample, EnvSaafError } = require('./index');

  // The issue's example: validates, coerces and nests; a missing grouped key
  // errors with the FULL env name (DB_HOST, not DB.HOST).
  const schema = {
    DB: { prefix: 'DB_', schema: {
      HOST: { type: 'host', required: true },
      PORT: { type: 'port', default: 5432 },
    } },
  };
  const out = validateEnv(schema, { DB_HOST: 'db.internal' });
  assert.deepStrictEqual(out, { DB: { HOST: 'db.internal', PORT: 5432 } });
  assert.deepStrictEqual(validateEnv(schema, { DB_HOST: 'db.internal', DB_PORT: '6543' }), { DB: { HOST: 'db.internal', PORT: 6543 } });
  assert.throws(
    () => validateEnv(schema, {}),
    err => err instanceof EnvSaafError && err.errors.length === 1 && err.errors[0] === 'DB_HOST: missing required variable',
  );
  // Coercion errors inside a group also name the full env name.
  assert.throws(
    () => validateEnv(schema, { DB_HOST: 'db.internal', DB_PORT: 'not-a-port' }),
    err => err instanceof EnvSaafError && err.errors.some(e => e.startsWith('DB_PORT:')),
  );
  // An optional inner key that is absent simply leaves the group without it;
  // when no inner key is present at all, the group key is absent too.
  const withOpt = { CACHE: { prefix: 'CACHE_', schema: { HOST: { type: 'host', required: true }, TTL: { type: 'int' } } } };
  assert.deepStrictEqual(validateEnv(withOpt, { CACHE_HOST: 'redis.local' }), { CACHE: { HOST: 'redis.local' } });
  // throwOnError: false returns the nested shape plus errors.
  const soft = validateEnv(schema, {}, { throwOnError: false });
  assert.deepStrictEqual(soft.env, { DB: { PORT: 5432 } }); // defaults still apply in soft mode
  assert.deepStrictEqual(soft.errors, ['DB_HOST: missing required variable']);

  // strict mode knows the flattened names: DB_HOST is fine, DB_OTHER is not.
  validateEnv(schema, { DB_HOST: 'db.internal', DB_PORT: '1' }, { strict: true, onWarn: () => {} });
  assert.throws(
    () => validateEnv(schema, { DB_HOST: 'db.internal', DB_OTHER: 'x' }, { strict: true }),
    err => err instanceof EnvSaafError && err.errors.some(e => e === 'DB_OTHER: set but not in schema (strict mode)'),
  );

  // aliases inside a group use FULL env names (verbatim, not prefixed).
  const withAlias = { DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true, aliases: ['DATABASE_HOST'] } } } };
  const warnings = [];
  const aliased = validateEnv(withAlias, { DATABASE_HOST: 'db.internal' }, { onWarn: m => warnings.push(m) });
  assert.deepStrictEqual(aliased, { DB: { HOST: 'db.internal' } });
  assert.ok(warnings.some(w => w.includes('DATABASE_HOST is deprecated')));

  // requiredIf across groups / to external keys uses full env names too.
  const crossGroup = {
    DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true } } },
    MAIL: { prefix: 'MAIL_', schema: { SMTP_HOST: { type: 'host', requiredIf: { key: 'DB_HOST', equals: 'db.internal' } } } },
  };
  assert.throws(
    () => validateEnv(crossGroup, { DB_HOST: 'db.internal' }),
    err => err instanceof EnvSaafError && err.errors.includes('MAIL_SMTP_HOST: missing required variable'),
  );
  assert.deepStrictEqual(
    validateEnv(crossGroup, { DB_HOST: 'other.host', MAIL_SMTP_HOST: 'smtp.local' }),
    { DB: { HOST: 'other.host' }, MAIL: { SMTP_HOST: 'smtp.local' } },
  );
  // requiredIf can also point at an undeclared external key (e.g. NODE_ENV).
  const ext = { A: { prefix: 'A_', schema: { KEY: { requiredIf: { key: 'NODE_ENV', equals: 'production' } } } } };
  assert.throws(
    () => validateEnv(ext, { NODE_ENV: 'production' }),
    err => err instanceof EnvSaafError && err.errors.includes('A_KEY: missing required variable'),
  );
  assert.deepStrictEqual(validateEnv(ext, { NODE_ENV: 'development' }), {});

  // transform inside a group lands nested, type-verified as usual.
  const withTransform = { S: { prefix: 'S_', schema: { NAME: { type: 'string', transform: v => v.toUpperCase() } } } };
  assert.deepStrictEqual(validateEnv(withTransform, { S_NAME: 'abc' }), { S: { NAME: 'ABC' } });

  // generateExample emits FLAT env names for a group, with a group comment.
  const example = generateExample({
    APP_NAME: { type: 'string', required: true },
    DB: { prefix: 'DB_', schema: { HOST: { type: 'host', required: true }, PORT: { type: 'port', default: 5432 } } },
  });
  assert.ok(example.includes('# group DB'));
  assert.ok(example.includes('DB_HOST='));
  assert.ok(example.includes('DB_PORT=5432'));
  assert.ok(!example.includes('DB.HOST'), 'example must stay flat');
  assert.ok(example.indexOf('APP_NAME=') < example.indexOf('DB_HOST='));

  // loadEnv with a group: returns the nested shape; assign writes FLAT names.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-group-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, 'DB_HOST=db.internal\nDB_PORT=6543\n');
    const loaded = loadEnv(schema, { path: file, env: {} });
    assert.deepStrictEqual(loaded, { DB: { HOST: 'db.internal', PORT: 6543 } });
    const target = {};
    loadEnv(schema, { path: file, env: target, assign: true });
    assert.strictEqual(target.DB_HOST, 'db.internal');
    assert.strictEqual(target.DB_PORT, '6543');
    assert.ok(!('DB' in target), 'assign must not write a nested group object');
    // required inner rule counts when no file is found
    assert.throws(
      () => loadEnv(schema, { paths: [path.join(dir, 'missing.env')], env: {} }),
      /required variables missing: DB_HOST/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // validateSchema rejects malformed groups up front (flat schemas unchanged).
  const bad = (s, msgPart) => assert.throws(
    () => validateSchema(s),
    err => err instanceof EnvSaafError && err.errors.some(e => e.includes(msgPart)),
    JSON.stringify(s),
  );
  bad({ G: { schema: { A: {} } } }, 'needs a non-empty string "prefix"');                 // no prefix
  bad({ G: { prefix: 'G_', schema: 'nope' } }, 'group "schema" must be an object');          // schema not an object
  bad({ G: { prefix: 'G_', schema: {} } }, 'group "schema" must not be empty');                // empty group
  bad({ G: { prefix: 'G_', schema: { A: {} }, type: 'string' } }, 'cannot also set "type"');  // type + schema
  bad({ G: { prefix: 'G_', schema: { A: {} }, required: true } }, 'group rules only support'); // extra option on group
  bad({ G: { prefix: 'G_', schema: { A: { schema: {} } } } }, 'groups cannot be nested');     // nested group
  bad({ G: { prefix: 'G_', schema: { A: { type: 'nope' } } } }, 'G_A: unknown type');         // inner rule error uses full name
  bad({ DB_HOST: { type: 'string' }, G: { prefix: 'DB_', schema: { HOST: {} } } }, 'collide'); // prefix collision with a declared key
  bad({ A: { prefix: 'X_', schema: { K: {} } }, B: { prefix: 'X_', schema: { K: {} } } }, 'collide'); // two groups collide
  // Issue #228 review fix: alias collisions are checked across the FLATTENED
  // schema — one env var must not silently feed two rules. All four
  // cross-boundary combinations are rejected:
  bad( // cross-group: a group-inner alias naming another group's key
    { A: { prefix: 'A_', schema: { H: { aliases: ['B_H'] } } }, B: { prefix: 'B_', schema: { H: {} } } },
    'A_H: alias "B_H" conflicts with a declared schema key',
  );
  bad( // two groups' inner rules sharing one alias
    { A: { prefix: 'A_', schema: { H: { aliases: ['SHARED'] } } }, B: { prefix: 'B_', schema: { H: { aliases: ['SHARED'] } } } },
    'alias "SHARED" is already used by',
  );
  bad( // a flat key colliding with a group-inner alias
    { FLAT_KEY: {}, A: { prefix: 'A_', schema: { H: { aliases: ['FLAT_KEY'] } } } },
    'A_H: alias "FLAT_KEY" conflicts with a declared schema key',
  );
  bad( // a flat rule's alias naming a group-produced key
    { A: { prefix: 'A_', schema: { H: {} } }, X: { aliases: ['A_H'] } },
    'X: alias "A_H" conflicts with a declared schema key',
  );
  // and the collision is no longer silent at validateEnv time either: the
  // schema is rejected before any env var can feed two rules.
  assert.throws(
    () => validateEnv(
      { A: { prefix: 'A_', schema: { H: { aliases: ['B_H'] } } }, B: { prefix: 'B_', schema: { H: {} } } },
      { B_H: 'shared.host' },
    ),
    err => err instanceof EnvSaafError && err.errors.some(e => e.includes('alias "B_H"')),
  );
  // non-conflicting cross-group aliases still work
  validateSchema({
    A: { prefix: 'A_', schema: { H: { aliases: ['OLD_A_HOST'] } } },
    B: { prefix: 'B_', schema: { H: { aliases: ['OLD_B_HOST'] } } },
  });

  // a valid group passes validateSchema
  validateSchema(schema);

  // Flat schemas behave exactly as before (regression guard).
  assert.deepStrictEqual(
    validateEnv({ PORT: { type: 'port', default: 3000 }, NAME: { type: 'string' } }, { NAME: 'x' }),
    { PORT: 3000, NAME: 'x' },
  );
}

// Issue #236: the README "Migrating to env-saaf" after-snippets must run against
// the current API — these tests execute exactly those snippets.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-migrating-'));
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=8080\nDATABASE_URL=https://db.example.com/x\nAPI_URL=https://api.example.com\nDEBUG=yes\n');
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    // "From dotenv" snippet.
    const { loadEnv } = require('./index');
    const env = loadEnv({
      PORT: { type: 'port', default: 3000 },
      DATABASE_URL: { type: 'url', required: true },
      DEBUG: { type: 'boolean', default: false },
    });
    assert.strictEqual(env.PORT, 8080);
    assert.strictEqual(typeof env.PORT, 'number');
    assert.strictEqual(env.DATABASE_URL, 'https://db.example.com/x');
    assert.strictEqual(env.DEBUG, true);
    // "From envalid" snippet: same shape, plus error aggregation and choices.
    const env2 = loadEnv({
      API_URL: { type: 'url', required: true },
      PORT: { type: 'port', default: 3000 },
      DEBUG: { type: 'boolean', default: false },
    });
    assert.strictEqual(env2.PORT, 8080);
    assert.throws(
      () => validateEnv({ PORT: { type: 'port', required: true }, DATABASE_URL: { type: 'url', required: true } }, { PORT: 'abc' }),
      (err) => err instanceof EnvSaafError && err.errors.length === 2
        && err.errors.some((e) => e.includes('expected a port'))
        && err.errors.some((e) => e.includes('missing required variable'))
    );
    const collected = validateEnv({ PORT: { type: 'port' } }, { PORT: 'abc' }, { throwOnError: false });
    assert.ok(Array.isArray(collected.errors) && collected.errors[0].includes('expected a port'));
    assert.strictEqual(validateEnv({ MODE: { type: 'string', choices: ['dev', 'prod'] } }, { MODE: 'prod' }).MODE, 'prod');
    assert.deepStrictEqual(validateEnv({ CFG: { type: 'json' } }, { CFG: '{"a":1}' }).CFG, { a: 1 });
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Issue #223: generateExample — array placeholder items come from the `of` item type
{
  // The reported case: `of: 'int'` must not suggest 'a,b,c' (which would not validate).
  assert.throws(() => validateEnv({ NS: { type: 'array', of: 'int' } }, { NS: 'a,b,c' }), /NS\[0\]/);
  const exInt = generateExample({ NS: { type: 'array', of: 'int' } });
  assert.ok(exInt.includes('NS=1,2,3'), exInt);
  // port items get port examples; string (the default) stays 'a,b,c'.
  assert.ok(generateExample({ PORTS: { type: 'array', of: 'port' } }).includes('PORTS=3000,8080,5432'));
  assert.ok(generateExample({ TAGS: { type: 'array' } }).includes('TAGS=a,b,c'));
  assert.ok(generateExample({ TAGS: { type: 'array', of: 'string' } }).includes('TAGS=a,b,c'));
  // A custom separator joins the typed items too.
  assert.ok(generateExample({ NS: { type: 'array', of: 'int', separator: ';' } }).includes('NS=1;2;3'));
  // An explicit default still wins over the generated placeholder.
  assert.ok(generateExample({ NS: { type: 'array', of: 'int', default: [7, 8] } }).includes('NS=7,8'));
  // A secret-looking key still gets an empty placeholder, array or not.
  assert.ok(generateExample({ API_KEY_LIST: { type: 'array', of: 'string' } }).includes('API_KEY_LIST=\n'));
  // The array comment names the item type so the generated file documents it.
  assert.ok(exInt.includes('# type: array, items: int'), exInt);

  // Round-trip: for every scalar `of` type, the generated placeholder is itself
  // valid against the rule — the init -> check loop stays clean. ('file' is
  // excluded: that type checks the path exists on disk, which a placeholder
  // in a fresh repo cannot guarantee.)
  const scalarTypes = ['string', 'email', 'number', 'int', 'boolean', 'url', 'uuid', 'hex', 'ipv4', 'semver', 'base64', 'port', 'date', 'duration', 'host', 'json'];
  for (const of of scalarTypes) {
    const ex = generateExample({ K: { type: 'array', of } });
    const line = ex.split('\n').find((l) => l.startsWith('K='));
    const value = line.slice(2);
    const parsed = validateEnv({ K: { type: 'array', of } }, { K: value });
    assert.ok(Array.isArray(parsed.K) && parsed.K.length === 3, `${of}: generated "${value}" must validate`);
  }
  // JSON items must not contain the separator — a single-key object per item.
  const exJson = generateExample({ DOCS: { type: 'array', of: 'json' } });
  assert.ok(exJson.includes('DOCS={"a":1},{"b":2},{"c":3}'), exJson);

  // minItems/maxItems are respected so the placeholder passes those bounds too.
  const exMin = generateExample({ NS: { type: 'array', of: 'int', minItems: 5 } });
  assert.ok(exMin.includes('NS=1,2,3,1,2'), exMin);
  assert.deepStrictEqual(validateEnv({ NS: { type: 'array', of: 'int', minItems: 5 } }, { NS: '1,2,3,1,2' }).NS, [1, 2, 3, 1, 2]);
  const exMax = generateExample({ NS: { type: 'array', of: 'int', maxItems: 2 } });
  assert.ok(exMax.includes('NS=1,2\n'), exMax);
  assert.deepStrictEqual(validateEnv({ NS: { type: 'array', of: 'int', maxItems: 2 } }, { NS: '1,2' }).NS, [1, 2]);
  // minItems and maxItems together: capped by maxItems.
  assert.ok(generateExample({ NS: { type: 'array', of: 'int', minItems: 5, maxItems: 4 } }).includes('NS=1,2,3,1\n'));
}

// Issue #251: generateExample — every scalar type gets a placeholder that
// itself validates, so the generated file passes `check` out of the box.
{
  const schema = {
    E: { type: 'email' }, U: { type: 'uuid' }, N: { type: 'number' },
    I: { type: 'int' }, B: { type: 'boolean' }, J: { type: 'json' },
    B64: { type: 'base64' }, HX: { type: 'hex' },
  };
  const ex = generateExample(schema);
  assert.ok(ex.includes('E=user@example.com'), ex);
  assert.ok(ex.includes('U=550e8400-e29b-41d4-a716-446655440000'), ex);
  assert.ok(ex.includes('N=3.14'), ex);
  assert.ok(ex.includes('I=42'), ex);
  assert.ok(ex.includes('B=true'), ex);
  assert.ok(ex.includes('J={"key":"value"}'), ex);
  assert.ok(ex.includes('B64=aGVsbG8='), ex);
  assert.ok(ex.includes('HX=deadbeef'), ex);
  // Round-trip: the whole generated file validates cleanly.
  const parsed = validateEnv(schema, parseEnvFile(ex));
  assert.strictEqual(parsed.E, 'user@example.com');
  assert.strictEqual(parsed.U, '550e8400-e29b-41d4-a716-446655440000');
  assert.strictEqual(parsed.N, 3.14);
  assert.strictEqual(parsed.I, 42);
  assert.strictEqual(parsed.B, true);
  assert.deepStrictEqual(parsed.J, { key: 'value' });
  assert.strictEqual(parsed.B64, 'aGVsbG8=');
  assert.strictEqual(parsed.HX, 'deadbeef');
  // Placeholders for the already-correct types are unchanged.
  assert.ok(generateExample({ P: { type: 'port' } }).includes('P=3000'));
  assert.ok(generateExample({ A: { type: 'url' } }).includes('A=https://example.com'));
  assert.ok(generateExample({ D: { type: 'date' } }).includes('D=2026-01-31'));
  assert.ok(generateExample({ DU: { type: 'duration' } }).includes('DU=15m'));
  assert.ok(generateExample({ H: { type: 'host' } }).includes('H=localhost'));
  assert.ok(generateExample({ S: { type: 'semver' } }).includes('S=1.0.0'));
  assert.ok(generateExample({ IP: { type: 'ipv4' } }).includes('IP=192.168.0.1'));
  // `file` stays the documented exception: no placeholder can guarantee the
  // path exists, so its example is a path the user must create.
  assert.ok(generateExample({ F: { type: 'file' } }).includes('F=./config.json'));
}

// Issue #234: maskSecrets recurses into plain objects/arrays; cycles get a placeholder
{
  // The issue's example: the masked structure mirrors the input shape and
  // scalar leaves use today's maskValue shapes.
  const out = maskSecrets({ DB: { PASSWORD: 'hunter2' }, TAGS: ['a', 'b'] });
  assert.deepStrictEqual(out, { DB: { PASSWORD: 'hu***r2' }, TAGS: ['****', '****'] });
  // Flat input behaves byte-for-byte as today.
  assert.deepStrictEqual(maskSecrets({ KEY: 'sk_live_123456', EMPTY: '' }), { KEY: 'sk***56', EMPTY: '' });
  assert.deepStrictEqual(
    maskSecrets({ N: 12345, B: true, Z: null }),
    { N: maskValue(12345), B: maskValue(true), Z: maskValue(null) }
  );
  // Deep nesting and arrays of objects keep their shape.
  assert.deepStrictEqual(
    maskSecrets({ a: { b: { c: { d: 'secret-value' } } }, list: [{ X: 'abcdef' }, 'xy', 42] }),
    { a: { b: { c: { d: 'se***ue' } } }, list: [{ X: 'ab***ef' }, '****', '****'] }
  );
  // Non-plain values (Date, class instances) are leaves via maskValue, as today.
  const when = new Date('2026-01-01T00:00:00.000Z');
  assert.deepStrictEqual(maskSecrets({ AT: when }), { AT: maskValue(when) });
  class Cfg { constructor() { this.token = 'abcdef'; } }
  const cfg = new Cfg();
  assert.deepStrictEqual(maskSecrets({ C: cfg }), { C: maskValue(cfg) });
  // A self-referencing object returns without hanging: the repeated reference
  // becomes a fixed placeholder.
  const cyc = { NAME: 'abcdef' };
  cyc.self = cyc;
  assert.deepStrictEqual(maskSecrets(cyc), { NAME: 'ab***ef', self: '[Circular]' });
  // Same for a cycle through an array.
  const arr = ['abcdef'];
  arr.push(arr);
  assert.deepStrictEqual(maskSecrets({ LIST: arr }), { LIST: ['ab***ef', '[Circular]'] });
  // A repeated (non-cyclic) reference is also replaced with the placeholder.
  const shared = { TOKEN: 'abcdef' };
  assert.deepStrictEqual(maskSecrets({ A: shared, B: shared }), { A: { TOKEN: 'ab***ef' }, B: '[Circular]' });
  // The input is not mutated, and empty containers pass through.
  const input = { DB: { PASSWORD: 'hunter2' } };
  maskSecrets(input);
  assert.deepStrictEqual(input, { DB: { PASSWORD: 'hunter2' } });
  assert.deepStrictEqual(maskSecrets({}), {});
  assert.deepStrictEqual(maskSecrets({ LIST: [] }), { LIST: [] });
}

// Issue #222: scanCode — optional chaining `process.env?.KEY` / `import.meta.env?.KEY`
{
  // The reported case: an optional-chained read is a read.
  assert.deepStrictEqual(scanCode('const x = process.env?.MAYBE_KEY;'), ['MAYBE_KEY']);
  // Plain dot access keeps working unchanged.
  assert.deepStrictEqual(scanCode('const x = process.env.MAYBE_KEY;'), ['MAYBE_KEY']);
  // Optional and plain reads mix freely in one source: one sorted, unique list.
  assert.deepStrictEqual(scanCode('process.env.A; process.env?.B; process.env?.A; process.env.A;'), ['A', 'B']);
  // Bracket and backtick forms behind `?.` work too.
  assert.deepStrictEqual(scanCode("process.env?.['BRACKET']; process.env?.[`TICK`];"), ['BRACKET', 'TICK']);
  assert.deepStrictEqual(
    scanCode("import.meta.env?.VITE_A; import.meta.env?.['VITE_B']; import.meta.env?.[`VITE_C`];"),
    ['VITE_A', 'VITE_B', 'VITE_C']
  );
  // Chained further (`process.env?.A?.B`) still reports the env read `A`.
  assert.deepStrictEqual(scanCode('const y = process.env?.A?.B;'), ['A']);
  // A `?.` mention inside a comment, string or template text is still not a read.
  assert.deepStrictEqual(scanCode('// set process.env?.NOPE first'), []);
  assert.deepStrictEqual(scanCode('/* process.env?.BLOCK */'), []);
  assert.deepStrictEqual(scanCode('const s = "process.env?.STR";'), []);
  assert.deepStrictEqual(scanCode("const t = 'process.env?.QUOTE';"), []);
  assert.deepStrictEqual(scanCode('const u = `see process.env?.TMPL in docs`;'), []);
  // A real optional read and a decoy on the same line: only the read counts.
  assert.deepStrictEqual(scanCode('const g = process.env?.REAL; // process.env?.FAKE'), ['REAL']);
  assert.deepStrictEqual(scanCode('const g = process.env?.REAL; const s = "process.env?.STR2";'), ['REAL']);
  // An optional read inside a template's ${...} is a read; the text around it is not.
  assert.deepStrictEqual(scanCode('const v = `k=${process.env?.IN_TMPL} and process.env?.FAKE2`'), ['IN_TMPL']);
  // `process.env?.` with no identifier after it is not a read (and must not crash).
  assert.deepStrictEqual(scanCode('const z = process.env?.;'), []);
  // scanDir picks up optional-chained reads in real files, next to plain ones,
  // and still ignores comments — end to end through the CLI `scan` command.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-scan-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const u = process.env?.TS_KEY; // process.env?.NOPE\n');
  fs.writeFileSync(path.join(dir, 'src', 'b.mjs'), "import x from 'x';\nconst k = process.env['PLAIN'];\nconst o = process.env?.OPT_KEY;\n");
  const cli = path.join(__dirname, 'cli.js');
  const out = spawnSync('node', [cli, 'scan', path.join(dir, 'src'), '--json'], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(JSON.parse(out.stdout).vars, ['OPT_KEY', 'PLAIN', 'TS_KEY']);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Issue #222 (edge cases): optional-chaining details and the `check` round-trip
{
  // Keys with digits/underscores, and the double-quoted bracket form.
  assert.deepStrictEqual(scanCode('process.env?._PRIVATE_2; process.env?.["DQ_KEY"];'), ['DQ_KEY', '_PRIVATE_2']);
  // Duplicates across plain and optional forms collapse into one sorted entry.
  assert.deepStrictEqual(scanCode('process.env?.SAME; process.env.SAME; process.env?.SAME;'), ['SAME']);
  // import.meta.env optional reads sort together with process.env ones.
  assert.deepStrictEqual(scanCode('process.env?.ZZZ; import.meta.env?.AAA;'), ['AAA', 'ZZZ']);
  // Empty / non-string input does not crash and finds nothing.
  assert.deepStrictEqual(scanCode(''), []);
  assert.deepStrictEqual(scanCode(null), []);
  assert.deepStrictEqual(scanCode(undefined), []);
  assert.deepStrictEqual(scanCode(42), []);
  // `process.env?.` followed by a non-identifier is not a read.
  assert.deepStrictEqual(scanCode('process.env?.9BAD; process.env?.-X;'), []);
  // An optional chain on something that is not `env` is not reported.
  assert.deepStrictEqual(scanCode('const a = foo?.env?.BAR;'), []);
  // A block comment spanning lines masks optional reads inside it.
  assert.deepStrictEqual(scanCode('/* process.env?.L1\nprocess.env?.L2 */ const a = process.env?.REAL;'), ['REAL']);
  // The bracket key sits in a (masked) literal, but the head is code: still a read.
  assert.deepStrictEqual(scanCode("const a = process.env?.['IN_BRACKET'];"), ['IN_BRACKET']);
  // Destructuring keeps working next to optional reads.
  assert.deepStrictEqual(scanCode('const { D } = process.env; const o = process.env?.O;'), ['D', 'O']);

  // The motivation end to end: a key read ONLY through `?.` is "used", so
  // `check` against a .env.example declaring it must not flag it as UNUSED.
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-check-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const m = process.env?.MAYBE_KEY;\n');
  fs.writeFileSync(path.join(dir, '.env.example'), 'MAYBE_KEY=\n');
  const cli = path.join(__dirname, 'cli.js');
  const out = spawnSync('node', [cli, 'check', dir], { encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes('all clean'), out.stdout);
  assert.ok(!out.stdout.includes('UNUSED'), out.stdout);
  // ...while a key declared but never read at all is still flagged (exit 1).
  fs.writeFileSync(path.join(dir, '.env.example'), 'MAYBE_KEY=\nNEVER_READ=\n');
  const out2 = spawnSync('node', [cli, 'check', dir], { encoding: 'utf8' });
  assert.strictEqual(out2.status, 1);
  assert.ok(out2.stdout.includes('UNUSED: NEVER_READ'), out2.stdout);
  assert.ok(!out2.stdout.includes('UNUSED: MAYBE_KEY'), out2.stdout);
  fs.rmSync(dir, { recursive: true, force: true });
}

{
  const aliases = [
    'local.BEFORE_DECLARATION;',
    '// const phantom = /*',
    'const visible = /* note */ process.env; visible.VISIBLE;',
    '"const stringPhantom = /*";',
    'const afterString = /* note */ process.env; afterString.AFTER_STRING;',
    '\x60const templatePhantom = /*\x60;',
    'const afterTemplate = /* note */ import.meta.env; afterTemplate.AFTER_TEMPLATE;',
    'const tagged = import.meta.env\x60tagged\x60; tagged.EXTRA;',
    'const multilineTag = process.env',
    '\x60tagged\x60; multilineTag.EXTRA;',
    'const before = /* gap */ process.env; before.BEFORE_SOURCE;',
    'const comma = process.env, port = comma.COMMA;',
    'const unrelated = /* gap */ fallback; /* gap */ process.env; unrelated.NOPE;',
    'let increment = process.env',
    '++count; increment.INCREMENT;',
    'let decrement = process.env',
    '--count; decrement.DECREMENT;',
    'const $env = process.env;',
    'let local = process.env',
    'var vite = import.meta.env;',
    '$env.Z; local["A"]; local[\x60B\x60]; vite.VITE_X; $env.Z;',
    'const commented = process.env /* source */; commented.COMMENTED;',
    '[...local.ARGS]; local.PORT$NAME;',
    'config./* gap */local.OBJECT_ONLY; this.#local.OBJECT_ONLY;',
    'const continued = process.env',
    '["PORT"]; continued.length;',
    'other.NOPE; wrapper.$env.NOPE; prefix$env.NOPE;',
    '// local.COMMENT',
    '/* local.BLOCK; const hidden = process.env; */ hidden.NOPE;',
    '"const fake = process.env;"; fake.NOPE; "local.STRING";',
    '\x60local.TEXT ${local.EXPRESSION}\x60;',
    'const selected = process.env.SELECTED; selected.NOPE;',
    'const copy = process.env || {}; copy.NOPE;',
    'const { DIRECT } = process.env; import.meta.env?.VITE_DIRECT;',
  ].join('\n');
  assert.deepStrictEqual(scanCode(aliases),
    ['A', 'AFTER_STRING', 'AFTER_TEMPLATE', 'ARGS', 'B', 'BEFORE_SOURCE', 'COMMA', 'COMMENTED', 'DECREMENT', 'DIRECT', 'EXPRESSION', 'INCREMENT', 'SELECTED', 'VISIBLE', 'VITE_DIRECT', 'VITE_X', 'Z']);
}

// Issue #230: watch-mode integration test — spawn `cli.js check --watch` as a
// subprocess, edit files, and assert it re-runs (debounced) and exits 0 on Ctrl-C.
const watchModeTest = (async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-watch-'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\n');
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(process.env.PORT);\n');
    const childEnv = { PATH: process.env.PATH || '' };
    if (process.platform === 'win32') { if (process.env.SYSTEMROOT) childEnv.SYSTEMROOT = process.env.SYSTEMROOT; }
    else if (process.env.HOME) childEnv.HOME = process.env.HOME;
    const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'check', dir, '--watch'], { cwd: dir, env: childEnv });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const waitFor = async (pred, what, timeoutMs = 8000) => {
      const start = Date.now();
      while (!(typeof pred === 'function' ? pred() : pred.test(out))) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; output so far:\n${out}`);
        await sleep(50);
      }
    };
    const runCount = () => (out.match(/check finished, exit/g) || []).length;

    // initial run happens and reports the clean state
    await waitFor(/all clean/, 'initial result');
    assert.ok(/watching/.test(out), 'watch banner printed');
    assert.strictEqual(runCount(), 1);

    // editing the source re-runs the check and reports the new MISSING key
    fs.appendFileSync(path.join(dir, 'app.js'), 'console.log(process.env.NEW_KEY);\n');
    await waitFor(() => /MISSING in \.env\.example: NEW_KEY/.test(out) && runCount() >= 2, 're-run after source edit');
    assert.strictEqual(runCount(), 2);

    // editing the real .env re-runs too (EXTRA finding)
    fs.appendFileSync(path.join(dir, '.env'), 'LOCAL_ONLY=1\n');
    await waitFor(() => /EXTRA in \.env: LOCAL_ONLY/.test(out) && runCount() >= 3, 're-run after .env edit');

    // debounce: two rapid successive saves collapse into a single re-run
    const before = runCount();
    fs.appendFileSync(path.join(dir, 'app.js'), '// touch 1\n');
    await sleep(25);
    fs.appendFileSync(path.join(dir, 'app.js'), '// touch 2\n');
    await sleep(900);
    assert.strictEqual(runCount() - before, 1, `two rapid saves must collapse into one re-run (got ${runCount() - before})`);

    // Ctrl-C exits cleanly with code 0
    const exitCode = await new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGINT'); });
    assert.strictEqual(exitCode, 0, 'SIGINT in watch mode exits 0');
    assert.ok(/stopped watching/.test(out), 'prints a stop message');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('watch-mode tests passed');
})();

// Issue #230 (review blockers): watch mode survives error exits (missing
// template, malformed env file) and picks up --schema edits instead of
// re-running against the require()-cached schema.
const watchModeErrorPathTest = (async () => {
  const { spawn } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-watch2-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.js'), 'console.log(process.env.PORT);\n');
    fs.writeFileSync(path.join(dir, 'env.schema.cjs'), 'module.exports = { PORT: { type: "int", min: 1, max: 65535 } };\n');
    const childEnv = { PATH: process.env.PATH || '' };
    if (process.platform === 'win32') { if (process.env.SYSTEMROOT) childEnv.SYSTEMROOT = process.env.SYSTEMROOT; }
    else if (process.env.HOME) childEnv.HOME = process.env.HOME;
    const child = spawn(process.execPath, [path.join(__dirname, 'cli.js'), 'check', dir, '--schema', 'env.schema.cjs', '--watch'], { cwd: dir, env: childEnv });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    let exited = null;
    child.on('exit', (code) => { exited = code; });
    const waitFor = async (pred, what, timeoutMs = 8000) => {
      const start = Date.now();
      while (!(typeof pred === 'function' ? pred() : pred.test(out))) {
        if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}; output so far:\n${out}`);
        await sleep(50);
      }
    };
    const runCount = () => (out.match(/check finished, exit/g) || []).length;

    // Blocker 1a: starting watch with no .env.example reports exit 2 but keeps watching.
    await waitFor(/\.env\.example not found/, 'missing template message');
    await waitFor(/check finished, exit 2/, 'missing template exit-2 line');
    await sleep(400);
    assert.strictEqual(exited, null, 'watcher must not exit on a missing template');

    // Creating the template re-runs and goes clean.
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\n');
    await waitFor(() => /all clean/.test(out) && runCount() >= 2, 'clean re-run after template appears');

    // Blocker 1b: a malformed template mid-watch (duplicate key) reports the error,
    // logs exit 2, and the watcher stays alive; fixing it recovers.
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\nPORT=1\n');
    await waitFor(() => /duplicate key PORT/.test(out) && /check finished, exit 2/.test(out) && runCount() >= 3, 'duplicate-key error with exit 2, watcher alive');
    await sleep(400);
    assert.strictEqual(exited, null, 'watcher must not exit on a malformed template');
    fs.writeFileSync(path.join(dir, '.env.example'), 'PORT=\n');
    await waitFor(() => /all clean/.test(out) && runCount() >= 4, 'recovery after template fix');

    // Blocker 2: a --schema edit must re-run against the NEW schema (no stale require cache).
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n');
    await waitFor(() => runCount() >= 5, 're-run after .env appears');
    fs.writeFileSync(path.join(dir, 'env.schema.cjs'), 'module.exports = { PORT: { type: "int", min: 1, max: 100 } };\n');
    await waitFor(() => /INVALID: PORT/.test(out) && /check finished, exit 1/.test(out), 'schema edit picked up (INVALID from the new schema)');

    const exitCode = await new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGINT'); });
    assert.strictEqual(exitCode, 0, 'SIGINT in watch mode exits 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('watch-mode error-path tests passed');
})();

const loadEnvAsyncTest = (async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const { loadEnv, loadEnvAsync } = require('./index');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-saaf-async-'));
  const first = path.join(dir, 'first.env');
  const last = path.join(dir, 'last.env');
  const missing = path.join(dir, 'missing.env');
  const schema = { PORT: { type: 'port', required: true }, DATA: { type: 'json' } };
  try {
    fs.writeFileSync(first, 'PORT=3000\nDATA={"demo":true}\n');
    fs.writeFileSync(last, 'PORT=4000\n');
    const promise = loadEnvAsync(schema, { path: first, env: {} });
    assert.ok(promise instanceof Promise);
    assert.deepStrictEqual(await promise, { PORT: 3000, DATA: { demo: true } });
    assert.deepStrictEqual(await loadEnvAsync(schema, { paths: [missing, first, last], env: {} }),
      { PORT: 4000, DATA: { demo: true } });
    assert.deepStrictEqual(await loadEnvAsync({}, { paths: [missing], env: {} }), {});
    const defaultRead = fs.promises.readFile;
    try {
      fs.promises.readFile = async (file, encoding) => {
        assert.strictEqual(file, '.env');
        assert.strictEqual(encoding, 'utf8');
        throw Object.assign(new Error('synthetic missing file'), { code: 'ENOENT' });
      };
      assert.deepStrictEqual(await loadEnvAsync({}, { env: {} }), {});
    } finally {
      fs.promises.readFile = defaultRead;
    }

    for (const override of [false, true]) {
      const env = { PORT: '5000' };
      const options = { path: [first, last], env, override, assign: true };
      const syncEnv = { ...env };
      const expected = loadEnv(schema, { ...options, env: syncEnv });
      assert.deepStrictEqual(await loadEnvAsync(schema, options), expected);
      assert.deepStrictEqual(env, syncEnv);
      assert.deepStrictEqual(env, { PORT: override ? '4000' : '5000', DATA: '{"demo":true}' });
    }

    async function assertSameError(inputSchema, options) {
      let expected;
      assert.throws(() => loadEnv(inputSchema, options), error => {
        expected = error;
        return true;
      });
      await assert.rejects(loadEnvAsync(inputSchema, options), error => {
        assert.strictEqual(error.constructor, expected.constructor);
        assert.strictEqual(error.message, expected.message);
        assert.deepStrictEqual(error.errors, expected.errors);
        return true;
      });
    }

    await assertSameError(schema, { path: missing, env: {} });
    await assertSameError(schema, { paths: [missing], env: { PORT: '5000' } });
    await assertSameError(schema, { paths: [missing, dir], env: {} });
    await assertSameError(null, { get path() { throw new Error('options read too soon'); } });

    fs.writeFileSync(last, 'PORT=invalid\n');
    const env = { KEEP: 'synthetic' };
    await assertSameError(schema, { paths: [first, last], env, assign: true, throwOnError: false });
    assert.deepStrictEqual(env, { KEEP: 'synthetic' });

    let rawErrors;
    assert.throws(() => loadEnv(schema, { path: last, env: {} }), error => {
      assert.ok(error instanceof EnvSaafError);
      rawErrors = error.errors;
      return true;
    });
    let formatterCalls = 0;
    const formatError = (errors, { keys }) => {
      formatterCalls++;
      assert.deepStrictEqual(errors, rawErrors);
      assert.deepStrictEqual(keys, ['PORT', 'DATA']);
      return 'Invalid test configuration';
    };
    const isFormatted = (error) => {
      assert.ok(error instanceof EnvSaafError);
      assert.strictEqual(error.message, 'Invalid test configuration');
      assert.deepStrictEqual(error.errors, rawErrors);
      return true;
    };
    const invalidOptions = { path: last, env: {}, formatError, throwOnError: false };
    assert.throws(() => loadEnv(schema, invalidOptions), isFormatted);
    await assert.rejects(loadEnvAsync(schema, invalidOptions), isFormatted);
    assert.strictEqual(formatterCalls, 2);

    fs.writeFileSync(last, 'PORT=4000\nPORT=5000\n');
    await assertSameError(schema, { paths: [last, dir], env: {}, formatError });
    await assertSameError(schema, { path: dir, env: {}, formatError });
    await assertSameError(schema, { path: missing, env: {}, formatError });
    assert.strictEqual(formatterCalls, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// Issue #231: opt-in `formatError` hook customises the thrown message only.
{
  const schema = { PORT: { type: 'port', required: true }, TOKEN: { type: 'int', sensitive: true } };
  const bad = { PORT: 'abc', TOKEN: 'secret-synthetic-value' };
  let plain;
  assert.throws(() => validateEnv(schema, bad), (e) => { plain = e; return e instanceof EnvSaafError; });

  // Hook output becomes the message; raw errors are unchanged.
  let seen;
  assert.throws(() => validateEnv(schema, bad, {
    formatError: (errors, context) => { seen = { errors, context }; return `ALERT ${errors.length}: ${context.keys.join(',')}`; },
  }), (e) => {
    assert.ok(e instanceof EnvSaafError);
    assert.strictEqual(e.name, 'EnvSaafError');
    assert.strictEqual(e.message, 'ALERT 2: PORT,TOKEN');
    assert.deepStrictEqual(e.errors, plain.errors);
    return true;
  });
  assert.deepStrictEqual(seen.errors, plain.errors);
  assert.deepStrictEqual(Object.keys(seen.context), ['keys']);
  assert.deepStrictEqual(seen.context.keys, ['PORT', 'TOKEN']);
  assert.ok(!JSON.stringify(seen).includes('secret-synthetic-value'));

  // The hook gets an isolated copy: mutating it cannot change error.errors.
  assert.throws(() => validateEnv(schema, bad, {
    formatError: (errors) => { try { errors.push('x'); } catch (_) { /* frozen */ } return 'm'; },
  }), (e) => { assert.deepStrictEqual(e.errors, plain.errors); return true; });

  // Without the hook (or with an empty-string result), the default stays byte-for-byte.
  assert.strictEqual(plain.message, 'Invalid environment variables:\n' + plain.errors.map(x => `  - ${x}`).join('\n'));
  assert.throws(() => validateEnv(schema, bad, { formatError: () => '' }), (e) => e.message === '');

  // Throwing or non-string hooks fall back to the default message.
  for (const hook of [() => { throw new Error('boom'); }, () => 42, () => undefined, () => null, () => ({})]) {
    assert.throws(() => validateEnv(schema, bad, { formatError: hook }), (e) => { assert.strictEqual(e.message, plain.message); assert.deepStrictEqual(e.errors, plain.errors); return true; });
  }

  // Never called when validation passes.
  let calls = 0;
  validateEnv(schema, { PORT: '3000' }, { formatError: () => { calls++; return 'x'; } });
  assert.strictEqual(calls, 0);

  // throwOnError:false: nothing is thrown, so the hook is skipped and errors stay raw.
  const collected = validateEnv(schema, bad, { throwOnError: false, formatError: () => { calls++; return 'x'; } });
  assert.strictEqual(calls, 0);
  assert.deepStrictEqual(collected.errors, plain.errors);

  // A non-function hook is a programming error, rejected even when env is valid.
  for (const bad2 of [null, 'x', 1, {}]) {
    assert.throws(() => validateEnv(schema, { PORT: '3000' }, { formatError: bad2 }), /formatError/);
  }

  // Schema errors are bugs in code, not env problems: default message, hook unused.
  assert.throws(() => validateEnv({ A: { type: 'nope' } }, {}, { formatError: () => { calls++; return 'x'; } }),
    (e) => { assert.ok(e instanceof EnvSaafError); assert.ok(e.message.startsWith('Invalid environment variables:')); return true; });
  assert.strictEqual(calls, 0);

  // loadEnv threads the option through (it always throws, so throwOnError:false is ignored).
  const tmp = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'env-saaf-231-'));
  const envFile = require('node:path').join(tmp, 'empty.env');
  try {
    require('node:fs').writeFileSync(envFile, '');
    assert.throws(() => loadEnv(schema, { path: envFile, env: bad, formatError: (errs, ctx) => `L ${errs.length} ${ctx.keys.length}` }),
      (e) => e instanceof EnvSaafError && e.message === 'L 2 2' && e.errors.length === 2);
    assert.throws(() => loadEnv(schema, { path: envFile, env: bad, throwOnError: false, formatError: () => 'y' }), (e) => e.message === 'y');
    assert.throws(() => loadEnv(schema, { path: envFile, env: bad }), (e) => e.message === plain.message);
  } finally {
    require('node:fs').rmSync(tmp, { recursive: true, force: true });
  }
  console.log('formatError tests passed');
}

// Issue #276: non-string values in a hand-built env object. `null` counts
// as "not set" (like `undefined`) instead of becoming the string "null";
// objects and arrays on non-array rules fail with an error naming the key
// instead of coercing to "[object Object]" or "".
{
  assert.throws(() => validateEnv({ S: { type: 'string', required: true } }, { S: null }), /S: missing required variable/);
  assert.deepStrictEqual(validateEnv({ S: { type: 'string' } }, { S: null }), {});
  assert.strictEqual(validateEnv({ S: { type: 'string', default: 'dflt' } }, { S: null }).S, 'dflt');
  assert.strictEqual(validateEnv({ S: { type: 'string', default: 'dflt', aliases: ['OLD_S'] } }, { OLD_S: null }, { onWarn: () => {} }).S, 'dflt');
  assert.throws(() => validateEnv({ S: { type: 'string' } }, { S: {} }), /S: expected a string value, got an object/);
  assert.throws(() => validateEnv({ S: { type: 'string' } }, { S: [] }), /S: expected a string value, got an array/);
  assert.throws(() => validateEnv({ N: { type: 'int' } }, { N: {} }), /N: expected a string value, got an object/);
  // `json` rules keep passing already-parsed values through, by design.
  assert.deepStrictEqual(validateEnv({ J: { type: 'json' } }, { J: { a: 1 } }).J, { a: 1 });
  const partial = validateEnv({ S: { type: 'string' }, N: { type: 'int' } }, { S: {}, N: '5' }, { throwOnError: false });
  assert.deepStrictEqual(partial.errors, ['S: expected a string value, got an object']);
  assert.strictEqual(partial.env.N, 5);
  // A real array still works for an array rule; numbers/booleans are untouched.
  assert.deepStrictEqual(validateEnv({ A: { type: 'array', of: 'int' } }, { A: [1, 2] }).A, [1, 2]);
  assert.strictEqual(validateEnv({ S: { type: 'string' } }, { S: 42 }).S, '42');
  assert.strictEqual(validateEnv({ B: { type: 'boolean' } }, { B: true }).B, true);
}

// Issue #282: `of` / `separator` only apply to `array` rules and
// `protocols` only to `url` rules (plus `array`, where it flows to
// `of: 'url'` items) — anywhere else they are dead config and are rejected
// up front, mirroring the string-only checks of #211. min/max stay allowed
// on every type: they apply to any numeric value.
{
  assert.throws(() => validateEnv({ S: { type: 'string', of: 'int' } }, {}), /S: "of" only applies to type 'array'/);
  assert.throws(() => validateEnv({ N: { type: 'int', separator: ';' } }, {}), /N: "separator" only applies to type 'array'/);
  assert.throws(() => validateEnv({ S: { type: 'string', protocols: ['https'] } }, {}), /S: "protocols" only applies to type 'url'/);
  assert.throws(() => validateEnv({ B: { type: 'boolean', protocols: ['https'] } }, {}), /B: "protocols" only applies to type 'url'/);
  // The combinations that do apply keep working:
  assert.deepStrictEqual(validateEnv({ A: { type: 'array', of: 'url', protocols: ['https'] } }, { A: 'https://a.com,https://b.com' }).A, ['https://a.com', 'https://b.com']);
  assert.throws(() => validateEnv({ A: { type: 'array', of: 'url', protocols: ['https'] } }, { A: 'http://a.com' }), /expected a URL with one of these protocols/);
  assert.strictEqual(validateEnv({ U: { type: 'url', protocols: ['https'] } }, { U: 'https://a.com' }).U, 'https://a.com');
  assert.strictEqual(validateEnv({ S: { type: 'string', min: 1 } }, { S: 'x' }).S, 'x');
}

Promise.all([watchModeTest, watchModeErrorPathTest, loadEnvAsyncTest])
  .then(() => console.log('env-saaf v1.5.0: all tests passed'))
  .catch((err) => { console.error(err); process.exit(1); });
