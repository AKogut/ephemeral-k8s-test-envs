import { randomUUID } from 'node:crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { checkUpstream, proxyHandler } from './proxy.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

export function createApp(config: Config, logger: Logger): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // Bodies are buffered rather than parsed: the gateway has no business
  // interpreting payloads it only forwards.
  app.use(express.raw({ type: () => true, limit: config.maxBodyBytes }));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && incoming.length <= 200 ? incoming : randomUUID();
    req.log = logger.child({ requestId: req.requestId });
    res.setHeader('x-request-id', req.requestId);
    res.setHeader('x-env-id', config.envId);
    res.setHeader('x-served-by', config.serviceName);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      req.log.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round((Number(process.hrtime.bigint() - startedAt) / 1e6) * 100) / 100,
      });
    });
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', service: config.serviceName, envId: config.envId });
  });

  /**
   * Readiness fans out to both upstreams. The gateway is only useful when it can
   * actually reach what it fronts, so reporting ready while notes-service is
   * still starting would send the first shard's requests into a 502.
   */
  app.get('/readyz', (_req, res) => {
    void Promise.all([
      checkUpstream(config.auth, config.readinessTimeoutMs),
      checkUpstream(config.notes, config.readinessTimeoutMs),
    ]).then((upstreams) => {
      const allReady = upstreams.every((upstream) => upstream.status === 'ready');
      res.status(allReady ? 200 : 503).json({
        status: allReady ? 'ready' : 'not-ready',
        service: config.serviceName,
        envId: config.envId,
        upstreams,
      });
    });
  });

  app.get('/version', (_req, res) => {
    res.status(200).json({
      service: config.serviceName,
      version: process.env.SERVICE_VERSION ?? 'dev',
      commit: process.env.GIT_SHA ?? 'unknown',
      envId: config.envId,
      routes: {
        '/auth/*': config.auth.baseUrl,
        '/notes/*': config.notes.baseUrl,
      },
    });
  });

  // /auth/login -> auth-service /login (the prefix is a gateway concern only).
  app.use(
    '/auth',
    proxyHandler({
      upstream: config.auth,
      targetPrefix: '',
      timeoutMs: config.proxyTimeoutMs,
      gatewayName: config.serviceName,
    }),
  );

  // /notes/... -> notes-service /notes/... (the prefix is part of the real API).
  app.use(
    '/notes',
    proxyHandler({
      upstream: config.notes,
      targetPrefix: '/notes',
      timeoutMs: config.proxyTimeoutMs,
      gatewayName: config.serviceName,
    }),
  );

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: 'NOT_FOUND', message: 'No gateway route matches this path' },
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const parseError = error as { type?: string };
    if (parseError?.type === 'entity.too.large') {
      res.status(413).json({
        error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
      });
      return;
    }
    req.log.error('gateway error', {
      err: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return app;
}
