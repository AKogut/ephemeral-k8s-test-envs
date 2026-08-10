export interface UpstreamConfig {
  readonly name: string;
  readonly baseUrl: string;
}

export interface Config {
  readonly serviceName: string;
  readonly port: number;
  readonly envId: string;
  readonly nodeEnv: string;
  readonly auth: UpstreamConfig;
  readonly notes: UpstreamConfig;
  readonly proxyTimeoutMs: number;
  readonly readinessTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
  readonly shutdownGraceMs: number;
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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const logLevel = (env.LOG_LEVEL ?? 'info') as Config['logLevel'];

  return {
    serviceName: env.SERVICE_NAME ?? 'gateway',
    port: intFromEnv('PORT', 3000, env),
    envId: env.ENV_ID ?? 'local',
    nodeEnv: env.NODE_ENV ?? 'development',
    auth: {
      name: 'auth-service',
      baseUrl: stripTrailingSlash(env.AUTH_SERVICE_URL ?? 'http://localhost:3001'),
    },
    notes: {
      name: 'notes-service',
      baseUrl: stripTrailingSlash(env.NOTES_SERVICE_URL ?? 'http://localhost:3002'),
    },
    proxyTimeoutMs: intFromEnv('PROXY_TIMEOUT_MS', 10_000, env),
    readinessTimeoutMs: intFromEnv('READINESS_TIMEOUT_MS', 2000, env),
    maxBodyBytes: intFromEnv('MAX_BODY_BYTES', 512 * 1024, env),
    logLevel: ['debug', 'info', 'warn', 'error'].includes(logLevel) ? logLevel : 'info',
    shutdownGraceMs: intFromEnv('SHUTDOWN_GRACE_MS', 10_000, env),
  };
}
