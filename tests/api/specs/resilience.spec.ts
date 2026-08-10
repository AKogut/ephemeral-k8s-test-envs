import { createNote, expect, test } from '../fixtures/api.js';

test.describe('Resilience and error handling', () => {
  test('rejects malformed JSON with a structured error, not an HTML page', async ({ authed }) => {
    const response = await authed.post('/notes', {
      headers: { 'content-type': 'application/json' },
      data: '{"title": "unterminated',
    });

    expect(response.status()).toBe(400);
    expect(response.headers()['content-type']).toContain('application/json');
    expect((await response.json()).error.code).toBe('MALFORMED_JSON');
  });

  test('rejects an over-sized payload with 413', async ({ authed }) => {
    const response = await authed.post('/notes', {
      data: { title: 'Huge', body: 'x'.repeat(400_000) },
    });

    expect([400, 413]).toContain(response.status());
  });

  test('returns a consistent error envelope for every failure mode', async ({ api, authed }) => {
    const responses = [
      await api.get('/notes'),
      await authed.get('/notes/00000000-0000-0000-0000-000000000000'),
      await authed.post('/notes', { data: {} }),
      await api.get('/no-such-route'),
    ];

    for (const response of responses) {
      const body = await response.json();
      expect(Object.keys(body)).toEqual(['error']);
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
    }
  });

  test('never leaks a stack trace or internal path in an error body', async ({ authed }) => {
    const response = await authed.post('/notes', { data: { title: 123, tags: 'nope' } });
    const raw = await response.text();

    expect(raw).not.toMatch(/\/app\/dist/);
    expect(raw).not.toMatch(/at\s+\w+\s+\(/);
    expect(raw.toLowerCase()).not.toContain('node_modules');
  });

  test('rejects an unsupported method on a known path', async ({ authed }) => {
    const response = await authed.fetch('/notes', { method: 'TRACE' });
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('handles concurrent writes from one user without losing any', async ({ authed }) => {
    const created = await Promise.all(
      Array.from({ length: 15 }, (_unused, i) => createNote(authed, { title: `concurrent ${i}` })),
    );

    const listing = await (await authed.get('/notes?limit=100')).json();

    expect(listing.pagination.total).toBe(15);
    expect(new Set(created.map((note) => note.id)).size).toBe(15);
  });

  test('handles concurrent reads and writes on the same note', async ({ authed }) => {
    const note = await createNote(authed, { title: 'Contended' });

    const results = await Promise.all([
      authed.patch(`/notes/${note.id}`, { data: { title: 'write-a' } }),
      authed.get(`/notes/${note.id}`),
      authed.patch(`/notes/${note.id}`, { data: { body: 'write-b' } }),
      authed.get(`/notes/${note.id}`),
    ]);

    for (const response of results) expect(response.status()).toBe(200);
    expect((await (await authed.get(`/notes/${note.id}`)).json()).id).toBe(note.id);
  });

  test('does not hang when a request carries an unexpected content type', async ({ authed }) => {
    const response = await authed.post('/notes', {
      headers: { 'content-type': 'text/plain' },
      data: 'title=whatever',
    });

    expect(response.status()).toBeGreaterThanOrEqual(400);
    expect(response.status()).toBeLessThan(500);
  });
});
