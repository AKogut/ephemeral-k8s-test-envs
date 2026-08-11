import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import type { NoteStore } from './db.js';
import { ApiError } from './errors.js';
import { asyncRoute } from './middleware.js';

const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,29}$/;

const tagsSchema = z
  .array(z.string().regex(TAG_PATTERN, 'Tags must be lowercase alphanumeric with dashes, 1-30 chars'))
  .max(10, 'A note can carry at most 10 tags')
  .transform((tags) => [...new Set(tags)]);

const createNoteSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
  body: z.string().max(10_000, 'Body must be at most 10000 characters').default(''),
  tags: tagsSchema.default([]),
  pinned: z.boolean().default(false),
});

/**
 * Spelled out rather than derived via `createNoteSchema.partial()`.
 *
 * `.partial()` only makes each key optional — it keeps the `.default()` wrappers,
 * so `PATCH {"title":"x"}` would quietly reset `body` to "" and `tags` to [].
 * PUT keeps the defaults on purpose (it is a full replace); PATCH must not.
 */
const patchNoteSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
    body: z.string().max(10_000, 'Body must be at most 10000 characters'),
    tags: tagsSchema,
    pinned: z.boolean(),
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'Patch body must contain at least one field',
  });

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(30).optional(),
  pinned: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  sort: z.enum(['createdAt', 'updatedAt', 'title']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * A note that belongs to another user is reported as 404, not 403.
 *
 * 403 would confirm the id exists, which lets a caller enumerate other users'
 * note ids. `notes-authz.spec.ts` locks this behaviour in.
 */
async function requireOwnedNote(store: NoteStore, ownerId: string, id: string) {
  const note = await store.findById(ownerId, id);
  if (!note) throw ApiError.notFound('Note not found');
  return note;
}

/** Narrows Express' `string | string[] | undefined` path param to a plain id. */
function noteId(req: Request): string {
  const id = req.params.id;
  if (typeof id !== 'string' || id.length === 0) throw ApiError.notFound('Note not found');
  return id;
}

export function createNotesRouter(store: NoteStore, config: Config): Router {
  const router = Router();

  router.get(
    '/notes',
    asyncRoute(async (req, res) => {
      const query = listQuerySchema.parse(req.query);
      const ownerId = req.user!.id;

      const { items, total } = await store.list({
        ownerId,
        ...(query.q ? { search: query.q } : {}),
        ...(query.tag ? { tag: query.tag } : {}),
        ...(query.pinned ? { pinned: query.pinned === 'true' } : {}),
        limit: Math.min(query.limit, config.maxPageSize),
        offset: query.offset,
        sort: query.sort,
        order: query.order,
      });

      res.status(200).json({
        items,
        pagination: {
          total,
          limit: query.limit,
          offset: query.offset,
          hasMore: query.offset + items.length < total,
        },
      });
    }),
  );

  router.get(
    '/notes/stats',
    asyncRoute(async (req, res) => {
      const ownerId = req.user!.id;
      const tags = await store.tagCounts(ownerId);
      const { total } = await store.list({
        ownerId,
        limit: 1,
        offset: 0,
        sort: 'createdAt',
        order: 'desc',
      });
      res.status(200).json({ total, tags });
    }),
  );

  router.post(
    '/notes',
    asyncRoute(async (req, res) => {
      const input = createNoteSchema.parse(req.body);
      const note = await store.create(req.user!.id, input);
      res.status(201).location(`/notes/${note.id}`).json(note);
    }),
  );

  router.get(
    '/notes/:id',
    asyncRoute(async (req, res) => {
      res.status(200).json(await requireOwnedNote(store, req.user!.id, noteId(req)));
    }),
  );

  router.put(
    '/notes/:id',
    asyncRoute(async (req, res) => {
      const ownerId = req.user!.id;
      const id = noteId(req);
      await requireOwnedNote(store, ownerId, id);
      const input = createNoteSchema.parse(req.body);
      res.status(200).json(await store.replace(ownerId, id, input));
    }),
  );

  router.patch(
    '/notes/:id',
    asyncRoute(async (req, res) => {
      const ownerId = req.user!.id;
      const id = noteId(req);
      await requireOwnedNote(store, ownerId, id);
      const patch = patchNoteSchema.parse(req.body);
      res.status(200).json(await store.update(ownerId, id, patch));
    }),
  );

  router.delete(
    '/notes/:id',
    asyncRoute(async (req, res) => {
      const ownerId = req.user!.id;
      const id = noteId(req);
      await requireOwnedNote(store, ownerId, id);
      await store.remove(ownerId, id);
      res.status(204).end();
    }),
  );

  return router;
}

export function createSystemRouter(store: NoteStore, config: Config): Router {
  const router = Router();
  const startedAt = Date.now();

  router.get('/healthz', (_req, res) => {
    res.status(200).json({ status: 'ok', service: config.serviceName, envId: config.envId });
  });

  // Not wrapped in asyncRoute: a rejected store call here must become a 503
  // with the reason in the body, which is what Kubernetes and a human reading
  // `kubectl describe` both need. Handing it to the error handler would make
  // an unreachable database a 500 like any other.
  router.get('/readyz', (_req, res) => {
    store.ping().then(
      (notes) => {
        res.status(200).json({
          status: 'ready',
          service: config.serviceName,
          envId: config.envId,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          checks: { database: 'ok', notes, authMode: config.authMode },
        });
      },
      (error: unknown) => {
        res.status(503).json({
          status: 'not-ready',
          service: config.serviceName,
          checks: { database: error instanceof Error ? error.message : 'unknown error' },
        });
      },
    );
  });

  router.get('/version', (_req, res) => {
    res.status(200).json({
      service: config.serviceName,
      version: process.env.SERVICE_VERSION ?? 'dev',
      commit: process.env.GIT_SHA ?? 'unknown',
      envId: config.envId,
      node: process.version,
    });
  });

  return router;
}
