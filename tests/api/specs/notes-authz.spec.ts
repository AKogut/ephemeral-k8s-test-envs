import { createHmac } from 'node:crypto';
import { createNote, expect, test } from '../fixtures/api.js';

function signToken(claims: Record<string, unknown>, secret = process.env.JWT_SECRET ?? ''): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = encode({
    sub: '11111111-1111-1111-1111-111111111111',
    email: 'forged@example.test',
    iss: process.env.JWT_ISSUER ?? 'ephemeral-test-envs/auth-service',
    aud: process.env.JWT_AUDIENCE ?? 'ephemeral-test-envs',
    iat: now,
    exp: now + 3600,
    ...claims,
  });
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${payload}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

test.describe('Notes authorization and tenant isolation', () => {
  test('rejects an unauthenticated list request', async ({ api }) => {
    const response = await api.get('/notes');

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  test('rejects unauthenticated writes', async ({ api }) => {
    expect((await api.post('/notes', { data: { title: 'nope' } })).status()).toBe(401);
    expect((await api.delete('/notes/some-id')).status()).toBe(401);
  });

  test('rejects an invalid token', async ({ api }) => {
    const response = await api.get('/notes', {
      headers: { authorization: 'Bearer complete.rubbish.token' },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('TOKEN_INVALID');
  });

  test("hides another user's note behind a 404, not a 403", async ({ authed, authedAsOther }) => {
    const note = await createNote(authed, { title: 'Private' });

    const response = await authedAsOther.get(`/notes/${note.id}`);

    // 403 would confirm the id exists and turn the API into an id oracle.
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });

  test("refuses to update another user's note", async ({ authed, authedAsOther }) => {
    const note = await createNote(authed, { title: 'Untouchable' });

    expect((await authedAsOther.patch(`/notes/${note.id}`, { data: { title: 'hijacked' } })).status()).toBe(404);
    expect((await authedAsOther.put(`/notes/${note.id}`, { data: { title: 'hijacked' } })).status()).toBe(404);

    const unchanged = await (await authed.get(`/notes/${note.id}`)).json();
    expect(unchanged.title).toBe('Untouchable');
  });

  test("refuses to delete another user's note", async ({ authed, authedAsOther }) => {
    const note = await createNote(authed, { title: 'Survivor' });

    expect((await authedAsOther.delete(`/notes/${note.id}`)).status()).toBe(404);
    expect((await authed.get(`/notes/${note.id}`)).status()).toBe(200);
  });

  test("never includes another user's notes in a listing", async ({ authed, authedAsOther }) => {
    const mine = await createNote(authed, { title: 'Mine', tags: ['shared-tag'] });
    await createNote(authedAsOther, { title: 'Theirs', tags: ['shared-tag'] });

    const listing = await (await authed.get('/notes?tag=shared-tag&limit=100')).json();
    const ids = listing.items.map((item: { id: string }) => item.id);

    expect(ids).toContain(mine.id);
    expect(listing.items.every((item: { title: string }) => item.title !== 'Theirs')).toBe(true);
  });

  test('scopes tag statistics to the requesting user', async ({ authed, authedAsOther }) => {
    await createNote(authed, { tags: ['only-mine'] });
    await createNote(authedAsOther, { tags: ['only-theirs'] });

    const stats = await (await authed.get('/notes/stats')).json();
    const tags = stats.tags.map((entry: { tag: string }) => entry.tag);

    expect(tags).toContain('only-mine');
    expect(tags).not.toContain('only-theirs');
  });

  test('rejects a well-formed token that this environment did not sign', async ({ api }) => {
    const response = await api.get('/notes', {
      headers: { authorization: `Bearer ${signToken({}, 'a-secret-this-environment-does-not-use')}` },
    });

    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('TOKEN_INVALID');
  });

  for (const [claim, value] of [
    ['aud', 'some-other-audience'],
    ['iss', 'some-other-issuer'],
  ] as const) {
    test(`rejects a correctly signed token with the wrong ${claim}`, async ({ api, user }) => {
      test.skip(!process.env.JWT_SECRET, 'JWT_SECRET is not available to this run');

      const valid = await api.get('/notes', {
        headers: { authorization: `Bearer ${signToken({ sub: user.id, email: user.email })}` },
      });
      expect(valid.status()).toBe(200);

      const response = await api.get('/notes', {
        headers: {
          authorization: `Bearer ${signToken({ sub: user.id, email: user.email, [claim]: value })}`,
        },
      });

      expect(response.status()).toBe(401);
      expect((await response.json()).error.code).toBe('TOKEN_INVALID');
    });
  }
});
