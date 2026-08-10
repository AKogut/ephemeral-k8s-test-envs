import { DEFAULT_PASSWORD, expect, test, uniqueEmail } from '../fixtures/api.js';

test.describe('POST /auth/register', () => {
  test('creates a user and returns its public representation', async ({ api }) => {
    const email = uniqueEmail('register');
    const response = await api.post('/auth/register', {
      data: { email, password: DEFAULT_PASSWORD },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ email });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(body.createdAt)).not.toBeNaN();
  });

  test('never returns the password or its hash', async ({ api }) => {
    const response = await api.post('/auth/register', {
      data: { email: uniqueEmail('leak'), password: DEFAULT_PASSWORD },
    });

    const raw = await response.text();
    expect(raw).not.toContain(DEFAULT_PASSWORD);
    expect(raw.toLowerCase()).not.toContain('password_hash');
    expect(raw.toLowerCase()).not.toContain('salt');
  });

  test('rejects a duplicate email with 409', async ({ api }) => {
    const email = uniqueEmail('dupe');
    await api.post('/auth/register', { data: { email, password: DEFAULT_PASSWORD } });

    const second = await api.post('/auth/register', {
      data: { email, password: DEFAULT_PASSWORD },
    });

    expect(second.status()).toBe(409);
    expect((await second.json()).error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  test('treats email addresses case-insensitively when detecting duplicates', async ({ api }) => {
    const email = uniqueEmail('CaseTest');
    await api.post('/auth/register', { data: { email, password: DEFAULT_PASSWORD } });

    const upper = await api.post('/auth/register', {
      data: { email: email.toUpperCase(), password: DEFAULT_PASSWORD },
    });

    expect(upper.status()).toBe(409);
  });

  test('rejects a malformed email address', async ({ api }) => {
    const response = await api.post('/auth/register', {
      data: { email: 'definitely-not-an-email', password: DEFAULT_PASSWORD },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toContainEqual(
      expect.objectContaining({ path: 'email' }),
    );
  });

  test('rejects a password shorter than eight characters', async ({ api }) => {
    const response = await api.post('/auth/register', {
      data: { email: uniqueEmail('shortpw'), password: 'short' },
    });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.details).toContainEqual(
      expect.objectContaining({ path: 'password' }),
    );
  });

  test('reports every validation problem at once, not just the first', async ({ api }) => {
    const response = await api.post('/auth/register', {
      data: { email: 'nope', password: 'x' },
    });

    const details = (await response.json()).error.details;
    expect(details).toHaveLength(2);
    expect(details.map((detail: { path: string }) => detail.path).sort()).toEqual([
      'email',
      'password',
    ]);
  });

  test('rejects a request with no body', async ({ api }) => {
    const response = await api.post('/auth/register');
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
  });

  test('ignores unexpected extra fields rather than failing or storing them', async ({ api }) => {
    const email = uniqueEmail('extra');
    const response = await api.post('/auth/register', {
      data: { email, password: DEFAULT_PASSWORD, isAdmin: true, id: 'attacker-chosen-id' },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.id).not.toBe('attacker-chosen-id');
    expect(body.isAdmin).toBeUndefined();
  });

  test('allows the registered user to log in immediately', async ({ api }) => {
    const email = uniqueEmail('immediate');
    await api.post('/auth/register', { data: { email, password: DEFAULT_PASSWORD } });

    const login = await api.post('/auth/login', {
      data: { email, password: DEFAULT_PASSWORD },
    });

    expect(login.status()).toBe(200);
    expect((await login.json()).token).toBeTruthy();
  });
});
