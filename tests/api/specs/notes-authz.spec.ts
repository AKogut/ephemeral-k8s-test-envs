import { createNote, expect, test } from '../fixtures/api.js';

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

  test('does not accept a token signed for a different audience', async ({ api }) => {
    // A well-formed HS256 JWT signed with a secret this environment does not use.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: '11111111-1111-1111-1111-111111111111',
        email: 'forged@example.test',
        iss: 'some-other-issuer',
        aud: 'some-other-audience',
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    const response = await api.get('/notes', {
      headers: { authorization: `Bearer ${header}.${payload}.ZmFrZS1zaWduYXR1cmU` },
    });

    expect(response.status()).toBe(401);
  });
});
