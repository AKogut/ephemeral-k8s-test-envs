import { createNote, expect, test } from '../fixtures/api.js';

test.describe('Notes listing, filtering and pagination', () => {
  test('returns an empty, well-formed page for a user with no notes', async ({ authed }) => {
    const response = await authed.get('/notes');

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.items).toEqual([]);
    expect(body.pagination).toMatchObject({ total: 0, offset: 0, hasMore: false });
  });

  test('reports the total independently of the page size', async ({ authed }) => {
    for (let i = 0; i < 7; i += 1) await createNote(authed, { title: `note ${i}` });

    const page = await (await authed.get('/notes?limit=3')).json();

    expect(page.items).toHaveLength(3);
    expect(page.pagination.total).toBe(7);
    expect(page.pagination.hasMore).toBe(true);
  });

  test('walks every note exactly once across pages', async ({ authed }) => {
    const created = [];
    for (let i = 0; i < 10; i += 1) created.push(await createNote(authed, { title: `page ${i}` }));

    const seen: string[] = [];
    for (let offset = 0; offset < 10; offset += 4) {
      const page = await (await authed.get(`/notes?limit=4&offset=${offset}`)).json();
      seen.push(...page.items.map((item: { id: string }) => item.id));
    }

    expect(new Set(seen).size).toBe(10);
    expect(seen.sort()).toEqual(created.map((note) => note.id).sort());
  });

  test('reports hasMore as false on the final page', async ({ authed }) => {
    for (let i = 0; i < 5; i += 1) await createNote(authed, { title: `final ${i}` });

    const page = await (await authed.get('/notes?limit=5&offset=0')).json();
    expect(page.pagination.hasMore).toBe(false);
  });

  test('returns an empty page beyond the end of the collection', async ({ authed }) => {
    await createNote(authed);

    const page = await (await authed.get('/notes?offset=500')).json();

    expect(page.items).toEqual([]);
    expect(page.pagination.total).toBe(1);
    expect(page.pagination.hasMore).toBe(false);
  });

  test('filters by tag with an exact match, not a substring', async ({ authed }) => {
    await createNote(authed, { title: 'exact', tags: ['work'] });
    await createNote(authed, { title: 'longer', tags: ['workshop'] });

    const page = await (await authed.get('/notes?tag=work')).json();

    expect(page.pagination.total).toBe(1);
    expect(page.items[0].title).toBe('exact');
  });

  test('searches across title and body', async ({ authed }) => {
    await createNote(authed, { title: 'kubernetes basics', body: 'unrelated' });
    await createNote(authed, { title: 'unrelated', body: 'all about kubernetes' });
    await createNote(authed, { title: 'nothing', body: 'to see here' });

    const page = await (await authed.get('/notes?q=kubernetes')).json();
    expect(page.pagination.total).toBe(2);
  });

  test('treats LIKE wildcards in the query as literal characters', async ({ authed }) => {
    await createNote(authed, { title: 'plain title' });
    await createNote(authed, { title: '100% complete' });

    // An unescaped "%" would match every note.
    const page = await (await authed.get('/notes?q=100%25')).json();

    expect(page.pagination.total).toBe(1);
    expect(page.items[0].title).toBe('100% complete');
  });

  test('sorts by title ascending on request', async ({ authed }) => {
    for (const title of ['charlie', 'alpha', 'bravo']) await createNote(authed, { title });

    const page = await (await authed.get('/notes?sort=title&order=asc')).json();

    expect(page.items.map((item: { title: string }) => item.title)).toEqual([
      'alpha',
      'bravo',
      'charlie',
    ]);
  });

  test('lists pinned notes before unpinned ones regardless of sort', async ({ authed }) => {
    await createNote(authed, { title: 'zzz unpinned', pinned: false });
    await createNote(authed, { title: 'aaa pinned', pinned: true });

    const page = await (await authed.get('/notes?sort=title&order=asc')).json();

    expect(page.items[0].pinned).toBe(true);
  });

  test('rejects an out-of-range limit', async ({ authed }) => {
    expect((await authed.get('/notes?limit=0')).status()).toBe(400);
    expect((await authed.get('/notes?limit=1000')).status()).toBe(400);
    expect((await authed.get('/notes?limit=abc')).status()).toBe(400);
  });

  test('rejects a negative offset and an unknown sort key', async ({ authed }) => {
    expect((await authed.get('/notes?offset=-1')).status()).toBe(400);
    expect((await authed.get('/notes?sort=password')).status()).toBe(400);
  });

  test('counts tags across all of the user notes', async ({ authed }) => {
    await createNote(authed, { tags: ['alpha', 'beta'] });
    await createNote(authed, { tags: ['alpha'] });

    const stats = await (await authed.get('/notes/stats')).json();
    const alpha = stats.tags.find((entry: { tag: string }) => entry.tag === 'alpha');

    expect(stats.total).toBe(2);
    expect(alpha.count).toBe(2);
  });
});
