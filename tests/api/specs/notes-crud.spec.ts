import { createNote, expect, test } from '../fixtures/api.js';

test.describe('Notes CRUD', () => {
  test('creates a note and returns 201 with a Location header', async ({ authed }) => {
    const response = await authed.post('/notes', {
      data: { title: 'Shopping list', body: 'milk, bread', tags: ['home'], pinned: true },
    });

    expect(response.status()).toBe(201);
    const note = await response.json();
    expect(note).toMatchObject({
      title: 'Shopping list',
      body: 'milk, bread',
      tags: ['home'],
      pinned: true,
    });
    expect(response.headers().location).toBe(`/notes/${note.id}`);
  });

  test('defaults body, tags and pinned when they are omitted', async ({ authed }) => {
    const note = await createNote(authed, { title: 'Minimal' });

    expect(note.body).toBe('');
    expect(note.tags).toEqual([]);
    expect(note.pinned).toBe(false);
  });

  test('reads a note back by id', async ({ authed }) => {
    const created = await createNote(authed, { title: 'Readable', body: 'content' });

    const response = await authed.get(`/notes/${created.id}`);

    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ id: created.id, title: 'Readable' });
  });

  test('returns 404 for an unknown note id', async ({ authed }) => {
    const response = await authed.get('/notes/00000000-0000-0000-0000-000000000000');

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });

  test('PATCH updates only the supplied fields', async ({ authed }) => {
    const created = await createNote(authed, {
      title: 'Original',
      body: 'keep me',
      tags: ['keep'],
    });

    const response = await authed.patch(`/notes/${created.id}`, { data: { title: 'Updated' } });

    expect(response.status()).toBe(200);
    const updated = await response.json();
    expect(updated.title).toBe('Updated');
    expect(updated.body).toBe('keep me');
    expect(updated.tags).toEqual(['keep']);
  });

  test('PUT replaces the note, resetting omitted fields to their defaults', async ({ authed }) => {
    const created = await createNote(authed, {
      title: 'Original',
      body: 'will be cleared',
      tags: ['gone'],
      pinned: true,
    });

    const response = await authed.put(`/notes/${created.id}`, { data: { title: 'Replaced' } });

    expect(response.status()).toBe(200);
    const replaced = await response.json();
    expect(replaced.title).toBe('Replaced');
    expect(replaced.body).toBe('');
    expect(replaced.tags).toEqual([]);
    expect(replaced.pinned).toBe(false);
  });

  test('rejects an empty PATCH body', async ({ authed }) => {
    const created = await createNote(authed);

    const response = await authed.patch(`/notes/${created.id}`, { data: {} });

    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_FAILED');
  });

  test('advances updatedAt but preserves createdAt on update', async ({ authed }) => {
    const created = await createNote(authed, { title: 'Timestamps' });
    // SQLite stores millisecond precision; make sure the clock has moved on.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const updated = await (await authed.patch(`/notes/${created.id}`, {
      data: { title: 'Touched' },
    })).json();

    expect(updated.createdAt).toBe((created as unknown as { createdAt: string }).createdAt);
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(updated.createdAt));
  });

  test('deletes a note and returns 204 with no body', async ({ authed }) => {
    const created = await createNote(authed);

    const response = await authed.delete(`/notes/${created.id}`);

    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
    expect((await authed.get(`/notes/${created.id}`)).status()).toBe(404);
  });

  test('returns 404 when deleting the same note twice', async ({ authed }) => {
    const created = await createNote(authed);

    expect((await authed.delete(`/notes/${created.id}`)).status()).toBe(204);
    expect((await authed.delete(`/notes/${created.id}`)).status()).toBe(404);
  });

  test('gives every created note a distinct id', async ({ authed }) => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => createNote(authed).then((note) => note.id)),
    );

    expect(new Set(ids).size).toBe(5);
  });
});
