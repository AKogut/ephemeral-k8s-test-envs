import express, { type Express } from 'express';
import type { Config } from './config.js';
import type { UserStore } from './db.js';
import type { Logger } from './logger.js';
import { accessLog, errorHandler, notFoundHandler, requestContext } from './middleware.js';
import { createAuthRouter, createSystemRouter } from './routes.js';

export function createApp(store: UserStore, config: Config, logger: Logger): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '64kb' }));
  app.use(requestContext(config, logger));
  app.use(accessLog());

  app.use('/', createSystemRouter(store, config));
  app.use('/', createAuthRouter(store, config));

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
