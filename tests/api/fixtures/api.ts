import { randomUUID } from 'node:crypto';
import { test as base, request, type APIRequestContext } from '@playwright/test';

/**
 * Fixtures for the API suite.
 *
 * The important property here is that every test provisions its own user. The
 * shards all hit one shared notes-service database, so isolation cannot come
 * from resetting state between tests — two pods would race. Instead each test
 * owns a unique account, and notes-service's per-owner scoping keeps the data
 * apart. That is what makes the suite safe to split across an arbitrary number
 * of pods without changing a line of test code.
 */

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
}

export interface ApiFixtures {
  /** Unauthenticated client pointed at the gateway. */
  api: APIRequestContext;
  /** A freshly registered, logged-in user. */
  user: TestUser;
  /** Client that sends `Authorization: Bearer <user.token>` on every request. */
  authed: APIRequestContext;
  /** Second independent user, for cross-tenant isolation checks. */
  otherUser: TestUser;
  /** Client authenticated as `otherUser`. */
  authedAsOther: APIRequestContext;
  /** Direct client for auth-service, bypassing the gateway. */
  authService: APIRequestContext;
  /** Direct client for notes-service, bypassing the gateway. */
  notesService: APIRequestContext;
}

export const DEFAULT_PASSWORD = 'correct-horse-battery-staple';

/** Collision-proof across shards, pods and workers, and readable in a log. */
export function uniqueEmail(prefix = 'user'): string {
  const shard = process.env.SHARD_INDEX ?? process.env.JOB_COMPLETION_INDEX ?? '0';
  return `${prefix}-s${shard}-${randomUUID()}@example.test`;
}

export function baseUrls() {
  const base = process.env.BASE_URL ?? 'http://localhost:3000';
  return {
    gateway: base,
    auth: process.env.AUTH_URL ?? 'http://localhost:3001',
    notes: process.env.NOTES_URL ?? 'http://localhost:3002',
  };
}

async function registerAndLogin(api: APIRequestContext, prefix: string): Promise<TestUser> {
  const email = uniqueEmail(prefix);

  const registration = await api.post('/auth/register', {
    data: { email, password: DEFAULT_PASSWORD },
  });
  if (registration.status() !== 201) {
    throw new Error(
      `Fixture setup failed: register returned ${registration.status()} — ${await registration.text()}`,
    );
  }
  const { id } = (await registration.json()) as { id: string };

  const login = await api.post('/auth/login', { data: { email, password: DEFAULT_PASSWORD } });
  if (login.status() !== 200) {
    throw new Error(
      `Fixture setup failed: login returned ${login.status()} — ${await login.text()}`,
    );
  }
  const { token } = (await login.json()) as { token: string };

  return { id, email, password: DEFAULT_PASSWORD, token };
}

export const test = base.extend<ApiFixtures>({
  api: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: baseUrls().gateway });
    await use(context);
    await context.dispose();
  },

  user: async ({ api }, use) => {
    await use(await registerAndLogin(api, 'primary'));
  },

  otherUser: async ({ api }, use) => {
    await use(await registerAndLogin(api, 'secondary'));
  },

  authed: async ({ user }, use) => {
    const context = await request.newContext({
      baseURL: baseUrls().gateway,
      extraHTTPHeaders: { authorization: `Bearer ${user.token}`, accept: 'application/json' },
    });
    await use(context);
    await context.dispose();
  },

  authedAsOther: async ({ otherUser }, use) => {
    const context = await request.newContext({
      baseURL: baseUrls().gateway,
      extraHTTPHeaders: { authorization: `Bearer ${otherUser.token}`, accept: 'application/json' },
    });
    await use(context);
    await context.dispose();
  },

  authService: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: baseUrls().auth });
    await use(context);
    await context.dispose();
  },

  notesService: async ({ playwright }, use) => {
    const context = await playwright.request.newContext({ baseURL: baseUrls().notes });
    await use(context);
    await context.dispose();
  },
});

export { expect } from '@playwright/test';

/** Convenience for the many tests that need a note to exist first. */
export async function createNote(
  client: APIRequestContext,
  overrides: Partial<{ title: string; body: string; tags: string[]; pinned: boolean }> = {},
): Promise<{ id: string; title: string; body: string; tags: string[]; pinned: boolean }> {
  const response = await client.post('/notes', {
    data: { title: `note-${randomUUID().slice(0, 8)}`, ...overrides },
  });
  if (response.status() !== 201) {
    throw new Error(`createNote failed with ${response.status()}: ${await response.text()}`);
  }
  return (await response.json()) as {
    id: string;
    title: string;
    body: string;
    tags: string[];
    pinned: boolean;
  };
}
