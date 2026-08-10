import { expect, test } from '../fixtures/api.js';

test.describe('GET /auth/me', () => {
  test('returns the authenticated user', async ({ authed, user }) => {
    const response = await authed.get('/auth/me');

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ id: user.id, email: user.email });
  });

  test('rejects a request with no Authorization header', async ({ api }) => {
    const response = await api.get('/auth/me');

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  test('rejects a non-Bearer Authorization scheme', async ({ api, user }) => {
    const response = await api.get('/auth/me', {
      headers: { authorization: `Basic ${Buffer.from(user.email).toString('base64')}` },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  test('rejects a structurally invalid token', async ({ api }) => {
    const response = await api.get('/auth/me', {
      headers: { authorization: 'Bearer not-a-jwt' },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('TOKEN_INVALID');
  });

  test('rejects a token whose signature has been tampered with', async ({ api, user }) => {
    const [header, payload] = user.token.split('.');
    const forged = `${header}.${payload}.${'A'.repeat(43)}`;

    const response = await api.get('/auth/me', {
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('TOKEN_INVALID');
  });

  test('rejects a token with an altered payload', async ({ api, user }) => {
    const [header, payload, signature] = user.token.split('.');
    const decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    decoded.sub = '00000000-0000-0000-0000-000000000000';
    const tampered = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    const response = await api.get('/auth/me', {
      headers: { authorization: `Bearer ${header}.${tampered}.${signature}` },
    });

    expect(response.status()).toBe(401);
  });

  test('rejects the "none" algorithm', async ({ api, user }) => {
    // A classic JWT downgrade: re-sign with alg=none and an empty signature.
    const payload = user.token.split('.')[1]!;
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');

    const response = await api.get('/auth/me', {
      headers: { authorization: `Bearer ${header}.${payload}.` },
    });

    expect(response.status()).toBe(401);
  });

  test('echoes the environment and request id headers', async ({ authed }) => {
    const response = await authed.get('/auth/me', {
      headers: { 'x-request-id': 'me-trace-id' },
    });

    expect(response.headers()['x-request-id']).toBe('me-trace-id');
    expect(response.headers()['x-env-id']).toBeTruthy();
  });
});
