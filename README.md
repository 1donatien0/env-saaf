# env-saaf

Zero-dependency environment variable validator for Node.js. Fail fast at startup with clear errors, and get **typed** values back.

## The problem

Research into real developer pain points shows the same `.env` bugs again and again:

- Every `process.env` value is a **string**: `DEBUG=false` is truthy, and `"3000" + 1` becomes `"30001"`.
- A missing variable does not fail at startup — it fails **in production**, on the first request that needs it.
- `.env.example` only says what *should* exist, not what your code *actually uses* — the two drift apart silently.
- Checking variables one by one is tedious, and the first error hides all the others.

Existing fixes (zod, envalid) are powerful but heavy for small projects. `env-saaf` (`saaf` = साफ़, clean/clear) does the essential job with **zero dependencies**.

## Install

```bash
npm install env-saaf
```

## Use

```js
const { validateEnv } = require('env-saaf');

const env = validateEnv({
  PORT:      { type: 'port', required: true },
  DEBUG:     { type: 'boolean', default: false },
  API_URL:   { type: 'url', required: true },
  LOG_LEVEL: { type: 'string', choices: ['info', 'warn', 'error'], default: 'info' },
});

// env.PORT is a number, env.DEBUG is a real boolean
// Missing/invalid vars throw ONE error listing ALL problems
```

### Strict mode — catch typos in variable names

By default `validateEnv` only looks at keys in the schema. With `{ strict: true }` it also flags variables that are set but not in the schema — so a typo like `DATABSE_URL` next to the real `DATABASE_URL` no longer slips through:

```js
const env = validateEnv(schema, process.env, { strict: true });
// throws EnvSaafError listing e.g. "DATABSE_URL: set but not in schema (strict mode)"
```

Default stays off — many apps share one environment with other tools.

### Per-key `transform` — one custom step after coercion

Some values need one small custom step after type coercion that env-saaf cannot guess — splitting a comma-separated list, normalising case:

```js
const { validateEnv } = require('env-saaf');

const env = validateEnv({
  ALLOWED_ORIGINS: { type: 'string', transform: v => v.split(',').map(s => s.trim()) },
  SHOUTY_NAME:     { type: 'string', transform: v => v.toUpperCase() },
});
// env.ALLOWED_ORIGINS is an array, env.SHOUTY_NAME is upper-cased
```

The transform runs after coercion and after the `choices` check; if it throws, the error is collected like any other validation error (with the key named). It runs only on values actually provided — not on `default` values (defaults are still coerced and validated like any value, so a bad default fails with an error naming the key). In TypeScript the result type for that key is inferred from the transform's return type.

### `email` type and `pattern` — validate formats

```js
const env = validateEnv({
  ADMIN_EMAIL: { type: 'email', required: true },
  SLUG:        { type: 'string', pattern: /^[a-z0-9-]+$/ },
  API_KEY:     { type: 'string', pattern: /^sk_[A-Za-z0-9]+$/ },
});
```

The `email` check is pragmatic — one `@`, a non-empty local part and domain, and a dot in the domain — not full RFC 5322. `pattern` takes a `RegExp` that a string value must match; it runs after coercion and the `choices` check, and a mismatch error names the pattern that failed.

### `int` type and `min`/`max` — whole numbers and ranges

```js
const env = validateEnv({
  MAX_RETRIES: { type: 'int', min: 0, max: 5, default: 3 },
  TIMEOUT_MS:  { type: 'number', min: 100, max: 30000 },
});
```

`int` is like `number` but rejects fractional values (`3.5` fails, `42` and `1e3` pass). `min` and `max` work on `number`, `int` and `port`; either one can be used alone, and an out-of-range value is rejected with an error naming the allowed range.

### `json` type and `minLength`/`maxLength` — structured values and string lengths

```js
const env = validateEnv({
  FEATURE_FLAGS: { type: 'json', default: { beta: false } },
  API_TOKEN:     { type: 'string', minLength: 10, maxLength: 64, required: true },
});
```

`json` parses the value with `JSON.parse` — objects, arrays and primitives all come back parsed; invalid JSON is rejected with an error naming the key. A `default` may be given as an already-parsed object. `minLength` and `maxLength` work on string values (`string`, `email`, `url`, `uuid`, `hex`); either one can be used alone, and a too-short or too-long value is rejected with an error naming the allowed length. They combine with `pattern` — length is checked first, then the pattern.

### `uuid` and `hex` types — IDs and hex strings

```js
const env = validateEnv({
  TENANT_ID: { type: 'uuid', required: true },
  API_HASH:  { type: 'hex', length: 64 },
});
```

`uuid` accepts a canonical UUID (`8-4-4-4-12` hex groups, upper- and lowercase) and returns it unchanged; a malformed value is rejected with an error naming the key. `hex` accepts hexadecimal strings only (`deadBEEF42` passes, `0x1234` does not); the optional `length` option pins the exact size in characters, for fixed-size tokens and hashes.

### `trim: false` — keep whitespace when it matters

Values are trimmed before validation by default — handy for secrets pasted from dashboards with stray spaces. When the whitespace *is* the value, switch trimming off for that key:

```js
const env = validateEnv({
  TOKEN: { type: 'string', trim: false, required: true },
});
// TOKEN: '  secret  ' stays '  secret  '
```

`trim: false` only affects string-like types; numbers and booleans are unaffected (`' 42 '` still parses as `42`, `' true '` still parses as `true`).

### Loading a real `.env` file

One call does it — read the file, parse it, validate it:

```js
const { loadEnv } = require('env-saaf');

const env = loadEnv({
  PORT:    { type: 'port', required: true },
  API_URL: { type: 'url', required: true },
}); // reads `.env` by default
```

Options: `{ path: '.env.local' }` to read another file, `{ override: true }` to let the file win over `process.env` (by default existing `process.env` values win), `{ assign: true }` to write the validated values back into `process.env` as strings. A missing file throws a clear error unless every variable is optional. By default `process.env` is never mutated.

Several files can be layered — later files override earlier ones:

```js
const env = loadEnv(schema, { paths: ['.env', '.env.local'] });
// or: { path: ['.env', '.env.local'] }
```

Values may reference other values with `${VAR}` — handy for building URLs from parts. References resolve from the same file first, then `process.env`; single-quoted values and `\${VAR}` escapes stay literal:

```env
HOST=example.com
API_URL=https://${HOST}/api
```

Quoted values may also span several lines (PEM keys, JSON blobs) — parsing continues until the closing quote. A backslash-escaped quote (`\'` inside single quotes, `\"` inside double quotes) stays part of the value, so `B='it\'s'` is `it's`; other backslashes, such as a Windows path, are kept as-is.

The manual way still works too — parse the file and pass it in:

```js
const fs = require('node:fs');
const { parseEnvFile, validateEnv } = require('env-saaf');

const fileEnv = parseEnvFile(fs.readFileSync('.env', 'utf8'));
const env = validateEnv({
  PORT:    { type: 'port', required: true },
  API_URL: { type: 'url', required: true },
}, fileEnv);
```

ES modules work too:

```js
import { validateEnv } from 'env-saaf';
```

### TypeScript: the return type is inferred from the schema

The return type of `validateEnv` is inferred from the schema — a key with `type: 'port'` becomes `number`, a `boolean` key becomes `boolean`, and a key without `required` or `default` is `| undefined`:

```ts
import { validateEnv } from 'env-saaf';

const env = validateEnv({
  PORT:  { type: 'port', required: true },
  DEBUG: { type: 'boolean' },
});

env.PORT.toFixed(0); // OK — PORT: number
env.DEBUG;           // boolean | undefined
env.TYPO;            // TypeScript error — not in the schema
```

Pass the schema inline to `validateEnv(...)` (or use `as const`) so TypeScript can see the literal types. The `EnvResult<S>` and `EnvValue<R>` types are also exported separately.

## Recipes

These short patterns use only `validateEnv` options available in the current API.

### Database URL and connection-pool size

```js
const { validateEnv } = require('env-saaf');

const env = validateEnv({
  DATABASE_URL: { type: 'url', required: true },
  DB_POOL_SIZE: { type: 'number', default: 10 },
});
// env.DATABASE_URL is present; env.DB_POOL_SIZE is a number.
```

`url` validates URL syntax, while `number` converts the pool size from its environment string.

### Feature flags

```js
const { validateEnv } = require('env-saaf');

const env = validateEnv({
  ENABLE_EXPORTS: { type: 'boolean', default: false },
  ENABLE_PREVIEW: { type: 'boolean', default: false },
});

if (env.ENABLE_EXPORTS) console.log('Exports are enabled');
```

The boolean type accepts `true`/`false`, `yes`/`no`, `on`/`off`, and `1`/`0` (also `y`/`n`),
case-insensitively.

### Optional analytics key

```js
const { validateEnv } = require('env-saaf');

const env = validateEnv({
  ANALYTICS_WRITE_KEY: { type: 'string' },
});

if (env.ANALYTICS_WRITE_KEY !== undefined) {
  console.log('Analytics is configured'); // Use the key with your analytics client; do not log it.
}
```

Without `required` or `default`, a missing key is omitted from the result and has the TypeScript
type `string | undefined`.

### Different development and production requirements

```js
const { validateEnv } = require('env-saaf');

const mode = validateEnv({
  NODE_ENV: {
    type: 'string',
    choices: ['development', 'test', 'production'],
    default: 'development',
  },
}).NODE_ENV;

const env = validateEnv({
  DATABASE_URL:
    mode === 'production'
      ? { type: 'url', required: true }
      : { type: 'url', default: 'http://localhost:5432/app' },
});
```

Validate the mode first, then choose an ordinary schema in application code. `validateEnv` does not
provide conditional rules inside a schema.

### Keep `.env.example` honest (CLI)

CLI output is plain text by default, including in pipes and CI. For scripts that set a shared color preference, pass `--no-color` before or after the command, or set `NO_COLOR=1`.

```bash
npx env-saaf --version      # print the installed version
npx env-saaf scan ./src     # every env var your code actually uses
npx env-saaf check .        # code vs .env.example diff — exit 1 on any finding (CI-ready)
npx env-saaf check . --file .env.sample  # compare against a differently-named template file instead
npx env-saaf check . --json # machine-readable JSON output (ok/missing/extra) for CI or tooling
npx env-saaf scan ./src --json  # JSON list of used vars
npx env-saaf example ./src  # draft a .env.example from a code scan
```

When a real `.env` sits next to the template, `check` also compares their keys: a key in `.env` that is not documented (`EXTRA in .env: FOO (not in .env.example)`) is usually a typo, and a template key with no local value is reported as `MISSING in .env: BAR (in .env.example, not set locally)`. `--file` selects the template for both comparisons; with no `.env` file this extra check is skipped. In `--json` mode the findings appear as `envExtra` and `envMissing` alongside the existing `missing`, `extra` and `invalid` fields.

`check` exits 1 whenever it prints any finding, and `--json` `ok` carries the same value, so a CI job fails exactly when the output reports a problem; a fully clean project exits 0. `UNUSED` counts as a finding too: a key left in the template after its code usage is gone fails the run, so remove it from the template when you remove the last usage.

### Generate `.env.example` from a schema

The schema already knows every key — generate the example file from it instead of writing it by hand:

```js
const { generateExample } = require('env-saaf');
const fs = require('node:fs');
fs.writeFileSync('.env.example', generateExample({
  PORT:    { type: 'port', required: true },
  API_KEY: { type: 'string', required: true },
}));
```

```env
# Generated by env-saaf — put real values in .env (never commit .env)
# type: port, required
PORT=3000
# type: string, required
API_KEY=
```

Keys that look like secrets (`API_KEY`, `DB_PASSWORD`, …) get an empty placeholder — nothing safe to suggest for them. Other keys get a type-based placeholder, and an explicit `default` is used as-is.

### Log config without leaking secrets

```js
const { maskSecrets } = require('env-saaf');
console.log(maskSecrets(process.env)); // values masked: sk***56
```

## Versions

- **v0.1.0** — core `validateEnv`: types (string/number/boolean/url/port), required, defaults, choices, all-errors-at-once.
- **v0.2.0** — `.env` file parsing, code scanning (used vs documented diff), CLI (`check` / `scan`).
- **v1.0.0** — secret masking, `.env.example` generation from schema and from code scan, TypeScript definitions, stable API.
- **v1.1.0** — CLI `--help` exits 0, boolean `on`/`off`/`y`/`n`, `scanCode` finds `let`/`var` destructuring, inline comments stripped in `parseEnvFile`, `.mts`/`.cts` files scanned.
- **v1.2.0** — `email` type and `pattern` option, CLI `--json` output, per-key `transform`, `${VAR}` interpolation, multi-file `loadEnv`, multiline quoted values, CLI `--no-color`, `int` type with `min`/`max`, README recipes.
- **v1.3.0** — `json`, `uuid` and `hex` types, `minLength`/`maxLength` and `hex` `length` options, `trim: false`, `loadEnv` return-type inference, safer `.env.example` generation for secret keys, `assign: true` JSON fix.

## Contributing

Issues and pull requests are welcome — including tiny ones. Start with the issues labelled [`good first issue`](https://github.com/abhi478jeetur-rgb/env-saaf/labels/good%20first%20issue), and please read [CONTRIBUTING.md](CONTRIBUTING.md) first: it explains the zero-dependency rule and how to run the tests.

## Contributors

env-saaf exists thanks to everyone who has contributed code, fixes and ideas — this wall grows on its own as new pull requests land:

<a href="https://github.com/abhi478jeetur-rgb/env-saaf/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=abhi478jeetur-rgb/env-saaf" alt="env-saaf contributors" />
</a>

Want to see your face here? Pick a [`good first issue`](https://github.com/abhi478jeetur-rgb/env-saaf/labels/good%20first%20issue) and send a pull request.

## License

MIT © Abhijeet Kumar
