/** Tiny argv parser: `--key value`, `--key=value` and `--flag`. */
export function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;

    const body = token.slice(2);
    const eq = body.indexOf('=');

    if (eq !== -1) {
      parsed[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      parsed[body] = next;
      i += 1;
    } else {
      parsed[body] = true;
    }
  }

  return parsed;
}

/**
 * Resolves a value from CLI args, then environment, then a default.
 *
 * The env fallback is what lets the same script serve a developer typing
 * `--index 2` and a shard pod that only has `JOB_COMPLETION_INDEX` injected by
 * the Kubernetes Job controller.
 */
export function resolveOption(
  args: Record<string, string | boolean>,
  argName: string,
  envNames: readonly string[],
  fallback?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromArgs = args[argName];
  if (typeof fromArgs === 'string' && fromArgs !== '') return fromArgs;

  for (const envName of envNames) {
    const value = env[envName];
    if (value !== undefined && value !== '') return value;
  }

  return fallback;
}

export function requireInteger(value: string | undefined, name: string): number {
  if (value === undefined) throw new Error(`${name} is required`);
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || String(parsed) !== value.trim()) {
    throw new Error(`${name} must be an integer, received "${value}"`);
  }
  return parsed;
}
