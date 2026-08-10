import { createNote, expect, test } from '../fixtures/api.js';

test.describe('Notes validation', () => {
  test('requires a title', async ({ authed }) => {
    const response = await authed.post('/notes', { data: { body: 'no title here' } });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.details).toContainEqual(
      expect.objectContaining({ path: 'title' }),
    );
  });

  test('rejects an empty title', async ({ authed }) => {
    expect((await authed.post('/notes', { data: { title: '' } })).status()).toBe(400);
  });

  test('rejects a whitespace-only title', async ({ authed }) => {
    expect((await authed.post('/notes', { data: { title: '     ' } })).status()).toBe(400);
  });

  test('trims surrounding whitespace from the title', async ({ authed }) => {
    const note = await createNote(authed, { title: '  Padded  ' });
    expect(note.title).toBe('Padded');
  });

  test('rejects a title longer than 200 characters', async ({ authed }) => {
    const response = await authed.post('/notes', { data: { title: 'x'.repeat(201) } });
    expect(response.status()).toBe(400);
  });

  test('accepts a title of exactly 200 characters', async ({ authed }) => {
    const response = await authed.post('/notes', { data: { title: 'x'.repeat(200) } });
    expect(response.status()).toBe(201);
  });

  test('rejects a body longer than 10000 characters', async ({ authed }) => {
    const response = await authed.post('/notes', {
      data: { title: 'Long body', body: 'x'.repeat(10_001) },
    });
    expect(response.status()).toBe(400);
  });

  test('rejects tags that are not lowercase alphanumeric', async ({ authed }) => {
    for (const tag of ['UPPER', 'has space', 'sym$bol', '-leading-dash', '']) {
      const response = await authed.post('/notes', { data: { title: 'Tagged', tags: [tag] } });
      expect(response.status(), `tag "${tag}" should be rejected`).toBe(400);
    }
  });

  test('accepts valid tags', async ({ authed }) => {
    const note = await createNote(authed, { tags: ['work', 'q3-2026', 'a'] });
    expect(note.tags).toEqual(['work', 'q3-2026', 'a']);
  });

  test('de-duplicates repeated tags', async ({ authed }) => {
    const note = await createNote(authed, { tags: ['work', 'work', 'home'] });
    expect(note.tags).toEqual(['work', 'home']);
  });

  test('rejects more than ten tags', async ({ authed }) => {
    const tags = Array.from({ length: 11 }, (_unused, i) => `tag-${i}`);
    const response = await authed.post('/notes', { data: { title: 'Too many', tags } });
    expect(response.status()).toBe(400);
  });

  test('rejects a tags value that is not an array', async ({ authed }) => {
    const response = await authed.post('/notes', { data: { title: 'Bad tags', tags: 'work' } });
    expect(response.status()).toBe(400);
  });

  test('rejects a non-boolean pinned value', async ({ authed }) => {
    const response = await authed.post('/notes', { data: { title: 'Bad pin', pinned: 'yes' } });
    expect(response.status()).toBe(400);
  });

  test('stores text that looks like SQL without executing it', async ({ authed }) => {
    const hostile = "Robert'); DROP TABLE notes;--";
    const note = await createNote(authed, { title: hostile });

    expect(note.title).toBe(hostile);
    // The table must still be there afterwards.
    expect((await authed.get('/notes')).status()).toBe(200);
  });

  test('stores unicode and emoji faithfully', async ({ authed }) => {
    const title = 'Нотатка 📝 with ünïcödé';
    const note = await createNote(authed, { title, body: '日本語テキスト' });

    const fetched = await (await authed.get(`/notes/${note.id}`)).json();
    expect(fetched.title).toBe(title);
    expect(fetched.body).toBe('日本語テキスト');
  });
});
