import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

export interface AccessTokenClaims {
  sub: string;
  email: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
    }
  }
}

function extractBearer(header: string | undefined): string {
  if (!header) throw ApiError.unauthorized('UNAUTHORIZED', 'Authorization header is missing');
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    throw ApiError.unauthorized('UNAUTHORIZED', 'Authorization header must use the Bearer scheme');
  }
  return token;
}

/**
 * Short-lived positive cache for upstream verifications.
 *
 * Without it, a 4-shard test run turns every notes request into a second
 * network hop to auth-service, which makes auth-service the bottleneck and
 * measures the wrong thing. The TTL is deliberately small (seconds) so that
 * revocation still takes effect well inside a test run.
 */
class VerificationCache {
  private readonly entries = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  isFresh(token: string, now: number): boolean {
    const expiresAt = this.entries.get(token);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.entries.delete(token);
      return false;
    }
    return true;
  }

  remember(token: string, now: number): void {
    // Bounded so a test suite that mints thousands of tokens cannot grow this
    // map without limit.
    if (this.entries.size > 1000) this.entries.clear();
    this.entries.set(token, now + this.ttlMs);
  }
}

export interface AuthDependencies {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createAuthMiddleware(config: Config, deps: AuthDependencies = {}) {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = new VerificationCache(config.authCacheTtlMs);

  async function verifyUpstream(token: string, requestId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.authVerifyTimeoutMs);

    try {
      const response = await doFetch(`${config.authServiceUrl}/me`, {
        headers: { authorization: `Bearer ${token}`, 'x-request-id': requestId },
        signal: controller.signal,
      });

      if (response.status === 401) {
        throw ApiError.unauthorized('TOKEN_INVALID', 'Access token was rejected by auth-service');
      }
      if (!response.ok) {
        throw new ApiError(
          503,
          'UPSTREAM_UNAVAILABLE',
          `auth-service returned ${response.status}`,
        );
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // Timeouts and DNS/connection failures land here. A 503 (not a 401) is the
      // honest answer: we do not know whether the token is good.
      throw new ApiError(503, 'UPSTREAM_UNAVAILABLE', 'auth-service is unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  return async function requireAuth(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const token = extractBearer(req.header('authorization'));

      let claims: AccessTokenClaims;
      try {
        claims = jwt.verify(token, config.jwt.secret, {
          algorithms: ['HS256'],
          issuer: config.jwt.issuer,
          audience: config.jwt.audience,
        }) as AccessTokenClaims;
      } catch (error) {
        throw error instanceof jwt.TokenExpiredError
          ? ApiError.unauthorized('TOKEN_EXPIRED', 'Access token has expired')
          : ApiError.unauthorized('TOKEN_INVALID', 'Access token is not valid');
      }

      if (config.authMode === 'verify-with-auth-service') {
        const timestamp = now();
        if (!cache.isFresh(token, timestamp)) {
          await verifyUpstream(token, req.requestId);
          cache.remember(token, timestamp);
        }
      }

      req.user = { id: claims.sub, email: claims.email };
      next();
    } catch (error) {
      next(error);
    }
  };
}
