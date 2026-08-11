/**
 * Runtime configuration for notes-service.
 *
 * `authMode` is the interesting knob:
 *
 *   jwt-only                  – verify the token signature locally and stop there.
 *   verify-with-auth-service  – additionally call auth-service `GET /me`, so the
 *                               token is checked against live state (the user may
 *                               have been removed since the token was issued).
 *
 * The Helm chart defaults to `verify-with-auth-service` on purpose: it makes the
 * multi-pod deployment do real service-to-service work over cluster DNS instead
 * of two services that merely happen to share a namespace.
 */

export type AuthMode = 'jwt-only' | 'verify-with-auth-service';

export interface Config {
  readonly serviceName: string;
  readonly port: number;
  readonly nodeEnv: string;
  readonly envId: string;
  readonly database: DatabaseConfig;
  readonly jwt: {
    readonly secret: string;
    readonly issuer: string;
    readonly audience: string;
  };
  readonly authMode: AuthMode;
  readonly authServiceUrl: string;
  readonly authVerifyTimeoutMs: number;
  /** How long a successful upstream verification is trusted before re-checking. */
  readonly authCacheTtlMs: number;
  readonly maxPageSize: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly shutdownGraceMs: number;
}

const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me';

/**
 * Which store backs the service.
 *
 * `sqlite` keeps the database in the pod, which is why both data services are
 * pinned to one replica (ADR 0006). `postgres` puts it a network away, which
 * is what makes a second replica possible and a migration necessary.
 */
export type DatabaseBackend = 'sqlite' | 'postgres';

export interface DatabaseConfig {
  readonly backend: DatabaseBackend;
  /** sqlite only. */
  readonly path: string;
  /** postgres only. */
  readonly url: string;
  readonly poolSize: number;
  readonly connectTimeoutMs: number;
}

const BACKENDS: readonly DatabaseBackend[] = ['sqlite', 'postgres'];

function databaseFromEnv(env: NodeJS.ProcessEnv): DatabaseConfig {
  const backend = (env.DB_BACKEND ?? 'sqlite') as DatabaseBackend;

  // Named explicitly rather than inferred from whether DATABASE_URL is set. A
  // misspelled variable would then mean "quietly use SQLite", and the symptom
  // is an environment that works, passes, and is not testing what it claims.
  if (!BACKENDS.includes(backend)) {
    throw new Error(`DB_BACKEND must be one of ${BACKENDS.join(', ')}, received "${backend}"`);
  }

  const url = env.DATABASE_URL ?? '';
  if (backend === 'postgres' && url === '') {
    throw new Error('DATABASE_URL must be set when DB_BACKEND=postgres');
  }

  return {
    backend,
    path: env.DATABASE_PATH ?? ':memory:',
    url,
    poolSize: intFromEnv('DB_POOL_SIZE', 10, env),
    connectTimeoutMs: intFromEnv('DB_CONNECT_TIMEOUT_MS', 5_000, env),
  };
}

function intFromEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received "${raw}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const secret = env.JWT_SECRET ?? '';

  if (nodeEnv === 'production' && secret === '') {
    throw new Error('JWT_SECRET must be set when NODE_ENV=production');
  }

  // Validated before it is typed, not after. Asserting `as AuthMode` first told
  // the compiler the value was already one of the two, which narrowed it to
  // `never` inside the guard below — so the error message would have been
  // checked against a type that claimed the error could not happen.
  const requestedAuthMode = env.AUTH_MODE ?? 'jwt-only';
  if (requestedAuthMode !== 'jwt-only' && requestedAuthMode !== 'verify-with-auth-service') {
    throw new Error(
      `AUTH_MODE must be "jwt-only" or "verify-with-auth-service", received "${requestedAuthMode}"`,
    );
  }
  const authMode: AuthMode = requestedAuthMode;

  const logLevel = (env.LOG_LEVEL ?? 'info') as Config['logLevel'];

  return {
    serviceName: env.SERVICE_NAME ?? 'notes-service',
    port: intFromEnv('PORT', 3002, env),
    nodeEnv,
    envId: env.ENV_ID ?? 'local',
    database: databaseFromEnv(env),
    jwt: {
      secret: secret === '' ? DEV_JWT_SECRET : secret,
      issuer: env.JWT_ISSUER ?? 'ephemeral-test-envs/auth-service',
      audience: env.JWT_AUDIENCE ?? 'ephemeral-test-envs',
    },
    authMode,
    authServiceUrl: (env.AUTH_SERVICE_URL ?? 'http://localhost:3001').replace(/\/+$/, ''),
    authVerifyTimeoutMs: intFromEnv('AUTH_VERIFY_TIMEOUT_MS', 2000, env),
    authCacheTtlMs: intFromEnv('AUTH_CACHE_TTL_MS', 5000, env),
    maxPageSize: intFromEnv('MAX_PAGE_SIZE', 100, env),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    shutdownGraceMs: intFromEnv('SHUTDOWN_GRACE_MS', 10_000, env),
  };
}
