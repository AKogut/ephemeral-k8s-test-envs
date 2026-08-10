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
  readonly databasePath: string;
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

  const authMode = (env.AUTH_MODE ?? 'jwt-only') as AuthMode;
  if (authMode !== 'jwt-only' && authMode !== 'verify-with-auth-service') {
    throw new Error(`AUTH_MODE must be "jwt-only" or "verify-with-auth-service", received "${authMode}"`);
  }

  const logLevel = (env.LOG_LEVEL ?? 'info') as Config['logLevel'];

  return {
    serviceName: env.SERVICE_NAME ?? 'notes-service',
    port: intFromEnv('PORT', 3002, env),
    nodeEnv,
    envId: env.ENV_ID ?? 'local',
    databasePath: env.DATABASE_PATH ?? ':memory:',
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
