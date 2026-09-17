import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';
import { baseUrls, createNote, expect, test } from '../fixtures/api.js';

function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(baseUrls().gateway), { method: 'GET', path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * These tests are about the *edge*, not the business logic: that the gateway
 * routes to the right upstream, keeps a request id intact across a service hop
 * and does not corrupt bodies or status codes on the way through.
 */
test.describe('Gateway routing', () => {
  test('routes /auth to auth-service', async ({ authed }) => {
    const response = await authed.get('/auth/me');

    expect(response.status()).toBe(200);
    expect(response.headers()['x-upstream']).toBe('auth-service');
  });

  test('routes /notes to notes-service', async ({ authed }) => {
    const response = await authed.get('/notes');

    expect(response.status()).toBe(200);
    expect(response.headers()['x-upstream']).toBe('notes-service');
  });

  test('marks every proxied response as having passed through the gateway', async ({ authed }) => {
    const response = await authed.get('/notes');
    expect(response.headers()['x-gateway']).toBe('gateway');
  });

  test('propagates a caller-supplied request id to the upstream and back', async ({ authed }) => {
    const requestId = `gw-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const response = await authed.get('/notes', { headers: { 'x-request-id': requestId } });

    expect(response.headers()['x-request-id']).toBe(requestId);
  });

  test('generates a request id when the caller does not supply one', async ({ authed }) => {
    const response = await authed.get('/notes');
    expect(response.headers()['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('preserves upstream status codes rather than flattening them', async ({ authed, api }) => {
    expect((await api.get('/notes')).status()).toBe(401);
    expect((await authed.get('/notes/does-not-exist')).status()).toBe(404);
    expect((await authed.post('/notes', { data: {} })).status()).toBe(400);
    expect((await authed.get('/notes')).status()).toBe(200);
  });

  test('forwards request bodies without corrupting them', async ({ authed }) => {
    const body = 'x'.repeat(5000);
    const note = await createNote(authed, { title: 'Big body', body });

    const fetched = await (await authed.get(`/notes/${note.id}`)).json();
    expect(fetched.body).toHaveLength(5000);
    expect(fetched.body).toBe(body);
  });

  test('forwards a compressed request body the upstream can read', async ({ authed }) => {
    const response = await authed.post('/notes', {
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      data: gzipSync(JSON.stringify({ title: 'Compressed', body: 'y'.repeat(2000) })),
    });

    expect(response.status()).toBe(201);
    const note = await response.json();
    expect(note.title).toBe('Compressed');
    expect(note.body).toHaveLength(2000);
  });

  test('forwards a request that expects 100-continue', async ({ authed }) => {
    const response = await authed.post('/notes', {
      headers: { expect: '100-continue' },
      data: { title: 'Expecting' },
    });

    expect(response.status()).toBe(201);
    expect((await response.json()).title).toBe('Expecting');
  });

  test('does not let dot segments escape the route prefix', async () => {
    for (const path of ['/notes/../version', '/notes/%2e%2e/version']) {
      const response = await rawGet(path);

      expect(response.status, path).toBe(404);
      expect(JSON.parse(response.body).error.code, path).toBe('NOT_FOUND');
    }
  });

  test('passes 204 responses through with no body', async ({ authed }) => {
    const note = await createNote(authed);

    const response = await authed.delete(`/notes/${note.id}`);

    expect(response.status()).toBe(204);
    expect(await response.text()).toBe('');
  });

  test('returns 404 for a path that matches no route', async ({ api }) => {
    const response = await api.get('/definitely-not-a-route');

    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });

  test('reports its routing table on /version', async ({ api }) => {
    const response = await api.get('/version');

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.service).toBe('gateway');
    expect(body.routes['/auth/*']).toBeTruthy();
    expect(body.routes['/notes/*']).toBeTruthy();
  });
});
