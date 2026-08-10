import { expect, test } from '../fixtures/api.js';

/**
 * Checks the properties the *environment* has to satisfy, as opposed to the
 * application behaviour the other specs cover. If these fail, the namespace was
 * not stood up correctly — which is exactly what a per-PR environment needs to
 * find out before anyone reads the rest of the report.
 */
test.describe('Environment health', () => {
  test('every service reports liveness', async ({ api, authService, notesService }) => {
    for (const [name, client] of [
      ['gateway', api],
      ['auth-service', authService],
      ['notes-service', notesService],
    ] as const) {
      const response = await client.get('/healthz');
      expect(response.status(), `${name} /healthz`).toBe(200);
      expect((await response.json()).status).toBe('ok');
    }
  });

  test('every service reports readiness', async ({ api, authService, notesService }) => {
    for (const [name, client] of [
      ['gateway', api],
      ['auth-service', authService],
      ['notes-service', notesService],
    ] as const) {
      const response = await client.get('/readyz');
      expect(response.status(), `${name} /readyz`).toBe(200);
      expect((await response.json()).status).toBe('ready');
    }
  });

  test('the gateway readiness check reflects both upstreams', async ({ api }) => {
    const body = await (await api.get('/readyz')).json();

    expect(body.upstreams).toHaveLength(2);
    expect(body.upstreams.every((upstream: { status: string }) => upstream.status === 'ready')).toBe(
      true,
    );
  });

  test('all services agree on which environment they belong to', async ({
    api,
    authService,
    notesService,
  }) => {
    const ids = await Promise.all(
      [api, authService, notesService].map(async (client) => {
        const response = await client.get('/healthz');
        return (await response.json()).envId;
      }),
    );

    expect(new Set(ids).size, `services disagree on envId: ${ids.join(', ')}`).toBe(1);
  });

  test('all services report the same build', async ({ api, authService, notesService }) => {
    const versions = await Promise.all(
      [api, authService, notesService].map(async (client) => {
        const response = await client.get('/version');
        return (await response.json()).commit;
      }),
    );

    // A mismatch means the namespace is running a mix of image tags, which
    // would make any test result here meaningless.
    expect(new Set(versions).size, `mixed builds deployed: ${versions.join(', ')}`).toBe(1);
  });

  test('notes-service verifies tokens against auth-service in a deployed environment', async ({
    notesService,
  }) => {
    const body = await (await notesService.get('/readyz')).json();

    // The chart sets this mode on purpose so the deployment exercises a real
    // service-to-service call over cluster DNS.
    expect(['jwt-only', 'verify-with-auth-service']).toContain(body.checks.authMode);
  });

  test('liveness does not require authentication', async ({ notesService }) => {
    // A probe that needed a token would make the kubelet unable to restart a
    // wedged pod.
    expect((await notesService.get('/healthz')).status()).toBe(200);
  });

  test('services identify themselves on every response', async ({ authService }) => {
    const response = await authService.get('/healthz');
    expect(response.headers()['x-served-by']).toBe('auth-service');
  });
});
