import { DEFAULT_PASSWORD, expect, test, uniqueEmail } from '../fixtures/api.js';

test.describe('POST /auth/login', () => {
  test('returns a bearer token and the user for valid credentials', async ({ user, api }) => {
    const response = await api.post('/auth/login', {
      data: { email: user.email, password: user.password },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.tokenType).toBe('Bearer');
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.user).toMatchObject({ id: user.id, email: user.email });
  });

  test('accepts the email in a different case than it was registered with', async ({ user, api }) => {
    const response = await api.post('/auth/login', {
      data: { email: user.email.toUpperCase(), password: user.password },
    });

    expect(response.status()).toBe(200);
  });

  test('rejects a wrong password with 401', async ({ user, api }) => {
    const response = await api.post('/auth/login', {
      data: { email: user.email, password: 'definitely-the-wrong-password' },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('INVALID_CREDENTIALS');
  });

  test('rejects an unknown email with the same code as a wrong password', async ({ api }) => {
    const response = await api.post('/auth/login', {
      data: { email: uniqueEmail('ghost'), password: DEFAULT_PASSWORD },
    });

    // Identical response for "no such user" and "wrong password" — otherwise the
    // endpoint becomes an oracle for which emails are registered.
    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('INVALID_CREDENTIALS');
  });

  test('does not leak whether an account exists through the response body', async ({ user, api }) => {
    const wrongPassword = await api.post('/auth/login', {
      data: { email: user.email, password: 'wrong-password-here' },
    });
    const unknownUser = await api.post('/auth/login', {
      data: { email: uniqueEmail('ghost'), password: 'wrong-password-here' },
    });

    expect(await wrongPassword.json()).toEqual(await unknownUser.json());
  });

  test('rejects a login attempt with a missing password', async ({ user, api }) => {
    const response = await api.post('/auth/login', { data: { email: user.email } });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
  });

  test('issues a token that the notes API accepts', async ({ user, api }) => {
    const login = await api.post('/auth/login', {
      data: { email: user.email, password: user.password },
    });
    const { token } = await login.json();

    const notes = await api.get('/notes', { headers: { authorization: `Bearer ${token}` } });
    expect(notes.status()).toBe(200);
  });

  test('issues a token whose stated expiry matches its expiresIn', async ({ user, api }) => {
    const before = Date.now();
    const response = await api.post('/auth/login', {
      data: { email: user.email, password: user.password },
    });
    const body = await response.json();

    const expiresAt = Date.parse(body.expiresAt);
    const expected = before + body.expiresIn * 1000;
    expect(Math.abs(expiresAt - expected)).toBeLessThan(5000);
  });
});
