/**
 * The TeslaMate connection, as something you can configure rather than a variable you can
 * only set by editing a file over SSH and restarting the service.
 *
 * It was env-only, which meant adding a car to a running install was: ssh in, find .env,
 * get a Postgres URL exactly right by hand, restart, then read the journal to find out
 * whether it worked. Every one of those steps is a place to get a password wrong with no
 * feedback. The fields are separate here for the same reason a form beats a URL — a typo
 * in `postgresql://user:pass@host:5432/db` is invisible.
 */

export interface TeslamateConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/**
 * TeslaMate's own compose file uses these, and the overwhelming majority of installs never
 * change them. Prefilling is not a guess — it is the documented default, and being wrong
 * costs one failed Test.
 */
export const TESLAMATE_DEFAULTS: Omit<TeslamateConfig, 'password'> = {
  host: '127.0.0.1',
  port: 5432,
  user: 'teslamate',
  database: 'teslamate',
};

export const TESLAMATE_SETTING_KEYS = {
  host: 'teslamate.host',
  port: 'teslamate.port',
  user: 'teslamate.user',
  password: 'teslamate.password',
  database: 'teslamate.database',
} as const;

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Build the connection string.
 *
 * Every component is percent-encoded. A generated password containing `@` or `/` — which
 * `openssl rand -base64` produces routinely — silently truncates the URL at that character
 * and produces an authentication failure that looks like a wrong password. That is a bad
 * afternoon, and it is entirely avoidable here.
 */
export function toConnectionString(config: TeslamateConfig): string {
  const auth = config.password
    ? `${encode(config.user)}:${encode(config.password)}`
    : encode(config.user);
  return `postgresql://${auth}@${config.host}:${config.port}/${encode(config.database)}`;
}

/** Parse an existing URL, so an install configured via .env can be adopted rather than retyped. */
export function fromConnectionString(url: string): TeslamateConfig | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) return null;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!database) return null;
  return {
    host: parsed.hostname || TESLAMATE_DEFAULTS.host,
    port: parsed.port ? Number(parsed.port) : TESLAMATE_DEFAULTS.port,
    user: decodeURIComponent(parsed.username) || TESLAMATE_DEFAULTS.user,
    password: decodeURIComponent(parsed.password),
    database,
  };
}

export interface ConfigProblem {
  field: keyof TeslamateConfig;
  message: string;
}

/** Say what is wrong before attempting a connection, so a typo does not read as "unreachable". */
export function validateConfig(input: Partial<TeslamateConfig>): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  if (!input.host?.trim()) problems.push({ field: 'host', message: 'Host is required.' });
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push({ field: 'port', message: 'Port must be between 1 and 65535.' });
  }
  if (!input.user?.trim()) problems.push({ field: 'user', message: 'User is required.' });
  if (!input.database?.trim()) problems.push({ field: 'database', message: 'Database is required.' });
  return problems;
}

/**
 * A connection string with the password replaced, for logs and for the UI.
 *
 * The status endpoint is unauthenticated by default — the same as every other read on this
 * app — so it must never carry the database password, however convenient that would be for
 * debugging.
 */
export function redact(config: TeslamateConfig): string {
  return `postgresql://${config.user}:***@${config.host}:${config.port}/${config.database}`;
}

export function normalise(input: Partial<TeslamateConfig>): TeslamateConfig {
  return {
    host: (input.host ?? TESLAMATE_DEFAULTS.host).trim(),
    port: Number(input.port ?? TESLAMATE_DEFAULTS.port),
    user: (input.user ?? TESLAMATE_DEFAULTS.user).trim(),
    password: input.password ?? '',
    database: (input.database ?? TESLAMATE_DEFAULTS.database).trim(),
  };
}
