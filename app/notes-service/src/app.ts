import express, { type Express } from 'express';
import { createAuthMiddleware, type AuthDependencies } from './auth.js';
import type { Config } from './config.js';
import type { NoteStore } from './db.js';
import type { Logger } from './logger.js';
import { accessLog, errorHandler, notFoundHandler, requestContext } from './middleware.js';
import { createNotesRouter, createSystemRouter } from './routes.js';

export function createApp(
  store: NoteStore,
  config: Config,
  logger: Logger,
  deps: AuthDependencies = {},
): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '256kb' }));
  app.use(requestContext(config, logger));
  app.use(accessLog());

  // System routes stay unauthenticated: kubelet probes do not carry a JWT.
  app.use('/', createSystemRouter(store, config));

  app.use('/notes', createAuthMiddleware(config, deps));
  app.use('/', createNotesRouter(store, config));

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
