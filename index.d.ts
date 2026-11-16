export type EnvType = 'string' | 'number' | 'boolean' | 'url' | 'port' | 'email';

export interface EnvRule {
  type?: EnvType;
  required?: boolean;
  default?: string | number | boolean;
  choices?: Array<string | number | boolean>;
  /**
   * A regular expression a string value must match (e.g. a slug, or a
   * prefixed key like `sk_...`). Checked after coercion and `choices`,
   * before `transform`; a mismatch error names the pattern.
   */
  pattern?: RegExp;
  /**
   * Custom step applied after coercion and the `choices` check; its return
   * value is what lands in the result (e.g. split a comma list into an
   * array). Runs only on values actually provided, not on `default`s.
   */
  transform?: (value: any) => any;
}

export type EnvSchema = Record<string, EnvRule>;

/**
 * The value type of a rule, from the schema's `type` field:
 * 'number' / 'port' -> number, 'boolean' -> boolean,
 * everything else (string / url / no type given) -> string.
 * A rule with a `transform` returns the transform's return type instead.
 */
export type EnvValue<R extends EnvRule> =
  R extends { transform: (value: any) => infer T } ? T :
  R extends { type: 'number' } ? number :
  R extends { type: 'port' } ? number :
  R extends { type: 'boolean' } ? boolean :
  string;

/**
 * The return type of `validateEnv` — inferred from the schema.
 * A key with `required: true` or a `default` is always present;
 * the other keys are optional (`| undefined`), because validateEnv
 * omits missing keys from the result entirely.
 * Pass the schema inline to validateEnv(...) (or use `as const`)
 * so TypeScript can see the literal types.
 * If the schema already has a loose type (such as `EnvSchema`), the
 * result falls back to `Record<string, string | number | boolean>`.
 */
export type EnvResult<S extends EnvSchema> = string extends keyof S
  ? Record<string, string | number | boolean>
  : {
      [K in keyof S as S[K] extends { required: true } ? K : S[K] extends { default: unknown } ? K : never]: EnvValue<S[K]>;
    } & {
      [K in keyof S as S[K] extends { required: true } ? never : S[K] extends { default: unknown } ? never : K]?: EnvValue<S[K]> | undefined;
    };

export class EnvSaafError extends Error {
  errors: string[];
}

export interface ValidateOptions {
  /** Report variables that are set but not in the schema (default false). */
  strict?: boolean;
}

export function validateEnv<S extends EnvSchema>(schema: S, env?: Record<string, string | undefined>, options?: ValidateOptions): EnvResult<S>;

export interface LoadEnvOptions {
  /** One file, or several files in order (later files win). */
  path?: string | string[];
  /** Alias for passing several files at once. */
  paths?: string[];
  env?: Record<string, string | undefined>;
  override?: boolean;
  assign?: boolean;
  /** Passed through to validateEnv (e.g. strict: true). */
  strict?: boolean;
}

export function loadEnv<S extends EnvSchema>(schema: S, options?: LoadEnvOptions): Record<string, string | number | boolean>;
export function parseEnvFile(text: string): Record<string, string>;
export function scanCode(text: string): string[];
export function scanDir(dir: string): string[];
export function diffEnv(usedKeys: string[], documentedKeys: string[]): { usedNotDocumented: string[]; documentedNotUsed: string[] };
export function maskValue(value: unknown): string;
export function maskSecrets<T extends Record<string, unknown>>(obj: T): Record<keyof T, string>;
export function generateExample(schema: EnvSchema): string;
