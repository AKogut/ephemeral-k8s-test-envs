import type { Request, Response } from 'express';
import type { UpstreamConfig } from './config.js';

/**
 * Hand-rolled proxy on top of the runtime's own `fetch`.
 *
 * A proxy library would work, but this is ~60 lines, keeps the runtime image
 * free of proxy dependencies, and makes the two behaviours that actually matter
 * here explicit: `x-request-id` is propagated so one id spans all three
 * services, and an unreachable upstream becomes a 502/504 with the stack's
 * standard error envelope rather than a stray HTML error page.
 */

/** Hop-by-hop headers must not be forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

function forwardableHeaders(req: Request): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase()) || value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('x-request-id', req.requestId);
  headers.set('x-forwarded-by', 'gateway');
  return headers;
}

/**
 * Additionally dropped when copying the *response* back.
 *
 * `fetch` transparently decompresses, so forwarding the upstream's
 * `content-encoding: gzip` would label an already-plain body as compressed.
 */
const RESPONSE_ONLY_STRIP = new Set(['content-encoding', 'content-length']);

export interface ProxyOptions {
  upstream: UpstreamConfig;
  /** Path prefix on the upstream, e.g. `/notes`. Empty means "mount at root". */
  targetPrefix: string;
  timeoutMs: number;
  /** Value for the `x-gateway` marker header stamped on every proxied response. */
  gatewayName: string;
}

export function proxyHandler(options: ProxyOptions) {
  return async function proxy(req: Request, res: Response): Promise<void> {
    // Inside an `app.use(mount, ...)` handler, req.url is the path below the
    // mount point, so the upstream path is rebuilt from targetPrefix.
    const suffix = req.url === '/' ? '' : req.url;
    const target = `${options.upstream.baseUrl}${options.targetPrefix}${suffix}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const startedAt = process.hrtime.bigint();

    try {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const body = hasBody && Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

      const upstreamResponse = await fetch(target, {
        method: req.method,
        headers: forwardableHeaders(req),
        ...(body ? { body } : {}),
        signal: controller.signal,
        redirect: 'manual',
      });

      upstreamResponse.headers.forEach((value, key) => {
        const name = key.toLowerCase();
        if (HOP_BY_HOP.has(name) || RESPONSE_ONLY_STRIP.has(name)) return;
        res.setHeader(key, value);
      });
      // Set after the copy so the upstream's own headers cannot clobber the
      // markers the API tests use to prove a response travelled through here.
      res.setHeader('x-upstream', options.upstream.name);
      res.setHeader('x-gateway', options.gatewayName);

      const payload = Buffer.from(await upstreamResponse.arrayBuffer());
      req.log.debug('proxied', {
        target,
        status: upstreamResponse.status,
        upstreamMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      });

      res.status(upstreamResponse.status);
      if (payload.length === 0) res.end();
      else res.end(payload);
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      req.log.error('upstream request failed', {
        target,
        upstream: options.upstream.name,
        timedOut: aborted,
        err: error instanceof Error ? error.message : String(error),
      });

      res.status(aborted ? 504 : 502).json({
        error: {
          code: 'UPSTREAM_UNAVAILABLE',
          message: aborted
            ? `Upstream ${options.upstream.name} did not respond in time`
            : `Upstream ${options.upstream.name} is unreachable`,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface UpstreamHealth {
  name: string;
  status: 'ready' | 'not-ready' | 'unreachable';
  httpStatus?: number;
}

export async function checkUpstream(
  upstream: UpstreamConfig,
  timeoutMs: number,
): Promise<UpstreamHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${upstream.baseUrl}/readyz`, { signal: controller.signal });
    return {
      name: upstream.name,
      status: response.ok ? 'ready' : 'not-ready',
      httpStatus: response.status,
    };
  } catch {
    return { name: upstream.name, status: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
