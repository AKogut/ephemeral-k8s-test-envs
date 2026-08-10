/**
 * Minimal structured logger.
 *
 * One JSON object per line so that `kubectl logs` output stays parseable by any
 * log shipper without pulling a logging framework into the runtime image.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export type LogLevel = keyof typeof LEVELS;

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(
  level: LogLevel,
  bindings: Record<string, unknown> = {},
): Logger {
  const threshold = LEVELS[level];

  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: lvl,
      msg: message,
      ...bindings,
      ...fields,
    });
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
