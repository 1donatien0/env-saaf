// env-saaf type tests — checked by `tsc` only (part of `npm test`).
// Nothing runs at runtime: this file only verifies TypeScript inference.
// Issue #7: the return type of validateEnv must be inferred from the schema.
import { validateEnv, EnvSchema, EnvResult } from './index';

const env = validateEnv({
  PORT: { type: 'port', required: true },
  COUNT: { type: 'number', required: true },
  DEBUG: { type: 'boolean' },
  API_URL: { type: 'url', required: true },
  MODE: { type: 'string', default: 'dev' },
  NAME: { type: 'string' },
});

// required keys: exact types
const port: number = env.PORT;
const count: number = env.COUNT;
const url: string = env.API_URL;
const mode: string = env.MODE;
// optional keys: value or undefined
const debug: boolean | undefined = env.DEBUG;
const name: string | undefined = env.NAME;

// number methods must work (the real gap from issue #7)
const doubled: number = env.PORT * 2;
const fixed: string = env.COUNT.toFixed(0);

// EnvResult can also be used directly
type MyEnv = EnvResult<{ PORT: { type: 'port'; required: true }; DEBUG: { type: 'boolean' } }>;
const myPort: number = null as unknown as MyEnv['PORT'];
const myDebug: boolean | undefined = null as unknown as MyEnv['DEBUG'];

// @ts-expect-error — PORT is a number, not a string
const wrongType: string = env.PORT;
// @ts-expect-error — unknown key: not in the schema
const typo = env.TYPO_KEY;
// @ts-expect-error — an optional key can be undefined, not a plain boolean
const debugStrict: boolean = env.DEBUG;

// a loose schema (e.g. a variable typed as EnvSchema) falls back to the loose record
const looseSchema: EnvSchema = { PORT: { type: 'port', required: true } };
const loose = validateEnv(looseSchema);
const looseValue: string | number | boolean = loose.ANYTHING;

export { port, count, url, mode, debug, name, doubled, fixed, wrongType, typo, debugStrict, myPort, myDebug, looseValue };
