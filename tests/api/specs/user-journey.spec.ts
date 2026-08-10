import { DEFAULT_PASSWORD, expect, test, uniqueEmail } from '../fixtures/api.js';

/**
 * The slowest file in the suite by design: each test walks a full journey
 * through both services rather than probing one endpoint. It is what makes the
 * weight-aware shard plan visibly better than an even split — see
 * docs/sharding-strategy.md.
 */
test.describe('End-to-end user journeys', () => {
  test('a new user can register, log in and manage notes through the gateway', async ({ api }) => {
    const email = uniqueEmail('journey');

    const registration = await api.post('/auth/register', {
      data: { email, password: DEFAULT_PASSWORD },
    });
    expect(registration.status()).toBe(201);

    const login = await api.post('/auth/login', { data: { email, password: DEFAULT_PASSWORD } });
    expect(login.status()).toBe(200);
    const { token } = await login.json();
    const auth = { authorization: `Bearer ${token}` };

    const created = await api.post('/notes', {
      headers: auth,
      data: { title: 'Plan the migration', tags: ['work'], pinned: true },
    });
    expect(created.status()).toBe(201);
    const note = await created.json();

    const listed = await (await api.get('/notes', { headers: auth })).json();
    expect(listed.pagination.total).toBe(1);

    const updated = await api.patch(`/notes/${note.id}`, {
      headers: auth,
      data: { body: 'Step 1: inventory the services' },
    });
    expect((await updated.json()).body).toContain('inventory');

    expect((await api.delete(`/notes/${note.id}`, { headers: auth })).status()).toBe(204);
    expect((await (await api.get('/notes', { headers: auth })).json()).pagination.total).toBe(0);
  });

  test('a user builds up a tagged collection and filters it back down', async ({ authed }) => {
    const fixtures = [
      { title: 'Standup notes', tags: ['work', 'meetings'] },
      { title: 'Retro actions', tags: ['work'] },
      { title: 'Groceries', tags: ['home'] },
      { title: 'Holiday plan', tags: ['home', 'travel'] },
      { title: 'Reading list', tags: [] },
    ];

    for (const fixture of fixtures) await authed.post('/notes', { data: fixture });

    const work = await (await authed.get('/notes?tag=work')).json();
    expect(work.pagination.total).toBe(2);

    const home = await (await authed.get('/notes?tag=home')).json();
    expect(home.pagination.total).toBe(2);

    const stats = await (await authed.get('/notes/stats')).json();
    expect(stats.total).toBe(5);
    expect(stats.tags.find((entry: { tag: string }) => entry.tag === 'work').count).toBe(2);

    const searched = await (await authed.get('/notes?q=list')).json();
    expect(searched.items.map((item: { title: string }) => item.title)).toContain('Reading list');
  });

  test('two users work side by side without seeing each other', async ({
    authed,
    authedAsOther,
    user,
    otherUser,
  }) => {
    for (let i = 0; i < 4; i += 1) {
      await authed.post('/notes', { data: { title: `mine ${i}`, tags: ['shared'] } });
      await authedAsOther.post('/notes', { data: { title: `theirs ${i}`, tags: ['shared'] } });
    }

    const mine = await (await authed.get('/notes?tag=shared&limit=100')).json();
    const theirs = await (await authedAsOther.get('/notes?tag=shared&limit=100')).json();

    expect(mine.pagination.total).toBe(4);
    expect(theirs.pagination.total).toBe(4);
    expect(user.id).not.toBe(otherUser.id);

    const mineIds = new Set(mine.items.map((item: { id: string }) => item.id));
    const theirIds = theirs.items.map((item: { id: string }) => item.id);
    expect(theirIds.some((id: string) => mineIds.has(id))).toBe(false);
  });

  test('a token issued at the start of a journey stays valid throughout it', async ({
    api,
    authed,
  }) => {
    for (let i = 0; i < 12; i += 1) {
      const response = await authed.post('/notes', { data: { title: `step ${i}` } });
      expect(response.status(), `note ${i} should still be authorised`).toBe(201);
    }

    expect((await authed.get('/auth/me')).status()).toBe(200);
    expect((await api.get('/notes')).status()).toBe(401);
  });

  test('pagination stays consistent while the collection is being read', async ({ authed }) => {
    for (let i = 0; i < 12; i += 1) {
      await authed.post('/notes', { data: { title: `stable ${String(i).padStart(2, '0')}` } });
    }

    const firstPage = await (await authed.get('/notes?sort=title&order=asc&limit=5&offset=0')).json();
    const secondPage = await (await authed.get('/notes?sort=title&order=asc&limit=5&offset=5')).json();
    const thirdPage = await (await authed.get('/notes?sort=title&order=asc&limit=5&offset=10')).json();

    const titles = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map(
      (item: { title: string }) => item.title,
    );

    expect(titles).toHaveLength(12);
    expect(new Set(titles).size).toBe(12);
    expect(titles).toEqual([...titles].sort());
  });
});
