import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import type { UserStore } from './db.js';
import { ApiError } from './errors.js';
import { asyncRoute } from './middleware.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { issueAccessToken, verifyAccessToken } from './tokens.js';

const credentialsSchema = z.object({
  email: z.email({ message: 'Must be a valid email address' }).max(254),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(200, 'Password must be at most 200 characters'),
});

function publicUser(row: { id: string; email: string; created_at: string }) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

function bearerToken(header: string | undefined): string {
  if (!header) throw ApiError.unauthorized('UNAUTHORIZED', 'Authorization header is missing');
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw ApiError.unauthorized('UNAUTHORIZED', 'Authorization header must use the Bearer scheme');
  }
  return token;
}

export function createAuthRouter(store: UserStore, config: Config): Router {
  const router = Router();

  router.post(
    '/register',
    asyncRoute(async (req, res) => {
      const { email, password } = credentialsSchema.parse(req.body);

      if (await store.findByEmail(email)) {
        throw ApiError.conflict('EMAIL_ALREADY_REGISTERED', 'That email is already registered');
      }

      const { hash, salt } = await hashPassword(password, config.scryptCostLog2);
      const user = await store.insert({
        id: randomUUID(),
        email,
        password_hash: hash,
        password_salt: salt,
      });

      req.log.info('user registered', { userId: user.id });
      res.status(201).json(publicUser(user));
    }),
  );

  router.post(
    '/login',
    asyncRoute(async (req, res) => {
      const { email, password } = credentialsSchema.parse(req.body);
      const user = await store.findByEmail(email);

      // Same error and roughly the same cost whether or not the account exists,
      // so response codes and timing do not leak which emails are registered.
      if (!user) {
        await hashPassword(password, config.scryptCostLog2);
        throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
      }

      const matches = await verifyPassword(
        password,
        { hash: user.password_hash, salt: user.password_salt },
        config.scryptCostLog2,
      );
      if (!matches) {
        throw ApiError.unauthorized('INVALID_CREDENTIALS', 'Email or password is incorrect');
      }

      const issued = issueAccessToken(user, config);
      req.log.info('login succeeded', { userId: user.id });
      res.status(200).json({ ...issued, user: publicUser(user) });
    }),
  );

  router.get(
    '/me',
    asyncRoute(async (req, res) => {
      const token = bearerToken(req.header('authorization'));
      const result = verifyAccessToken(token, config);

      if (!result.ok) {
        throw result.reason === 'expired'
          ? ApiError.unauthorized('TOKEN_EXPIRED', 'Access token has expired')
          : ApiError.unauthorized('TOKEN_INVALID', 'Access token is not valid');
      }

      const user = await store.findById(result.claims.sub);
      if (!user) {
        // The token signature is valid but the subject is gone — possible after a
        // namespace is recycled while a client still holds an old token.
        throw ApiError.unauthorized('TOKEN_INVALID', 'Token subject no longer exists');
      }

      res.status(200).json(publicUser(user));
    }),
  );

  return router;
}

export function createSystemRouter(store: UserStore, config: Config): Router {
  const router = Router();
  const startedAt = Date.now();

  // Liveness: the process is up. Never touches the database, so a slow or
  // locked DB cannot cause a restart loop.
  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', service: config.serviceName, envId: config.envId });
  });

  // Readiness: the process can actually serve traffic, database included.
  //
  // Not wrapped in asyncRoute: a rejected store call here must become a 503
  // with the reason in the body, which is what Kubernetes and a human reading
  // `kubectl describe` both need. Handing it to the error handler would make
  // an unreachable database a 500 like any other.
  router.get('/readyz', (_req, res) => {
    store.count().then(
      (users) => {
        res.status(200).json({
          status: 'ready',
          service: config.serviceName,
          envId: config.envId,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          checks: { database: 'ok', users },
        });
      },
      (error: unknown) => {
        res.status(503).json({
          status: 'not-ready',
          service: config.serviceName,
          checks: { database: error instanceof Error ? error.message : 'unknown error' },
        });
      },
    );
  });

  router.get('/version', (_req, res) => {
    res.status(200).json({
      service: config.serviceName,
      version: process.env.SERVICE_VERSION ?? 'dev',
      commit: process.env.GIT_SHA ?? 'unknown',
      envId: config.envId,
      node: process.version,
    });
  });

  return router;
}
