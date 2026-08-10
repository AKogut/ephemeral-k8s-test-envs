import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import type { Logger } from './logger.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
      log: Logger;
    }
  }
}

/**
 * Adopts an inbound `x-request-id` when present so a request that entered
 * through the gateway keeps one id across all three services, which is what
 * makes a failing shard traceable end to end.
 */
export function requestContext(config: Config, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-request-id');
    req.requestId = incoming && incoming.length <= 200 ? incoming : randomUUID();
    req.log = logger.child({ requestId: req.requestId });
    res.setHeader('x-request-id', req.requestId);
    res.setHeader('x-env-id', config.envId);
    res.setHeader('x-served-by', config.serviceName);
    next();
  };
}

export function accessLog() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      req.log.info('request', {
        method: req.method,
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        userId: req.user?.id,
      });
    });
    next();
  };
}

export function notFoundHandler() {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    next(ApiError.notFound('No route matches this path'));
  };
}

export function errorHandler() {
  return (error: unknown, req: Request, res: Response, _next: NextFunction): void => {
    if (error instanceof ApiError) {
      res.status(error.status).json(error.toBody());
      return;
    }

    if (error instanceof ZodError) {
      const apiError = ApiError.badRequest(
        'VALIDATION_FAILED',
        'Request failed validation',
        error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
      res.status(apiError.status).json(apiError.toBody());
      return;
    }

    const bodyParserError = error as { type?: string };
    if (bodyParserError?.type === 'entity.too.large') {
      res.status(413).json(new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large').toBody());
      return;
    }
    if (bodyParserError?.type === 'entity.parse.failed') {
      res.status(400).json(new ApiError(400, 'MALFORMED_JSON', 'Request body is not valid JSON').toBody());
      return;
    }

    req.log.error('unhandled error', {
      err: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    res.status(500).json(new ApiError(500, 'INTERNAL_ERROR', 'Internal server error').toBody());
  };
}

export function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void> | void,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next);
  };
}
