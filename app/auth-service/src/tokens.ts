import jwt from 'jsonwebtoken';
import type { Config } from './config.js';

export interface AccessTokenClaims {
  sub: string;
  email: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface IssuedToken {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
  expiresAt: string;
}

/**
 * HS256 with a shared secret. `notes-service` verifies these tokens with the
 * same secret rather than fetching a JWKS — see docs/adr/0003-shared-secret-jwt.md
 * for why asymmetric keys were deliberately left out of scope.
 */
export function issueAccessToken(
  user: { id: string; email: string },
  config: Config,
): IssuedToken {
  const ttl = config.jwt.ttlSeconds;
  const token = jwt.sign({ email: user.email }, config.jwt.secret, {
    algorithm: 'HS256',
    subject: user.id,
    issuer: config.jwt.issuer,
    audience: config.jwt.audience,
    expiresIn: ttl,
  });

  return {
    token,
    tokenType: 'Bearer',
    expiresIn: ttl,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}

export type VerifyResult =
  | { ok: true; claims: AccessTokenClaims }
  | { ok: false; reason: 'expired' | 'invalid' };

export function verifyAccessToken(token: string, config: Config): VerifyResult {
  try {
    const claims = jwt.verify(token, config.jwt.secret, {
      algorithms: ['HS256'],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
    }) as AccessTokenClaims;
    return { ok: true, claims };
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) return { ok: false, reason: 'expired' };
    return { ok: false, reason: 'invalid' };
  }
}
