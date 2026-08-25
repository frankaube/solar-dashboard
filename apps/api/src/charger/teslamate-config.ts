/**
 * The TeslaMate connection, as configuration rather than an env var. The fields are kept
 * separate rather than as one URL because a typo inside
 * `postgresql://user:pass@host:5432/db` is invisible.
 */

export interface TeslamateConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** TeslaMate's own compose file uses these; few installs change them. */
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
 * Build the connection string, percent-encoding every component: a password containing `@`
 * or `/`, which `openssl rand -base64` produces routinely, otherwise truncates the URL
 * there and fails authentication in a way that looks like a wrong password.
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
 * A connection string with the password replaced, for logs and for the UI: the status
 * endpoint is unauthenticated by default and must never carry the database password.
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
