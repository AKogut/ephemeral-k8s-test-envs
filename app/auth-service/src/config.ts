/**
 * Runtime configuration, read once at boot from the environment.
 *
 * Every value has a development-friendly default so that `npm start` works with
 * no setup, while the Helm chart supplies explicit values for every knob in a
 * real environment. Failing fast on a missing secret in production is
 * deliberate: an ephemeral environment that silently boots with a default
 * signing key is worse than one that refuses to start.
 */

export interface Config {
  readonly serviceName: string;
  readonly port: number;
  readonly nodeEnv: string;
  /** Identifier of the ephemeral environment, e.g. `pr-123`. Echoed on every response. */
  readonly envId: string;
  readonly database: DatabaseConfig;
  readonly jwt: {
    readonly secret: string;
    readonly issuer: string;
    readonly audience: string;
    readonly ttlSeconds: number;
  };
  /** log2 of the scrypt cost parameter N. 14 (=16384) for real use, lower in CI. */
  readonly scryptCostLog2: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly shutdownGraceMs: number;
}

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

const DEV_JWT_SECRET = 'dev-only-insecure-secret-change-me';

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
    poolSize: intFromEnv('DB_POOL_SIZE', 10),
    connectTimeoutMs: intFromEnv('DB_CONNECT_TIMEOUT_MS', 5_000),
  };
}

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
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

  const logLevel = (env.LOG_LEVEL ?? 'info') as Config['logLevel'];

  return {
    serviceName: env.SERVICE_NAME ?? 'auth-service',
    port: intFromEnv('PORT', 3001),
    nodeEnv,
    envId: env.ENV_ID ?? 'local',
    database: databaseFromEnv(env),
    jwt: {
      secret: secret === '' ? DEV_JWT_SECRET : secret,
      issuer: env.JWT_ISSUER ?? 'ephemeral-test-envs/auth-service',
      audience: env.JWT_AUDIENCE ?? 'ephemeral-test-envs',
      ttlSeconds: intFromEnv('JWT_TTL_SECONDS', 3600),
    },
    scryptCostLog2: intFromEnv('SCRYPT_COST_LOG2', 14),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    shutdownGraceMs: intFromEnv('SHUTDOWN_GRACE_MS', 10_000),
  };
}
