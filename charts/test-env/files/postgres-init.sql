-- One server, one database per service.
--
-- The first attempt gave both services the same database, and it failed on the
-- first run: each service keeps its own numbered migration list, both start at
-- 1, and they share one `schema_migrations` ledger. Whichever migrated second
-- collided on the primary key.
--
-- Separating the ledgers by service would have fixed the symptom. Separating
-- the databases fixes the thing the symptom was pointing at: two services with
-- unrelated schemas were sharing one namespace, and the collision was the mild
-- version of that. It also makes the advisory lock in each migrate.js correct
-- without coordination, since those locks are scoped to a database.
--
-- Run once, by the Postgres image's own init hook, before anything connects.
CREATE DATABASE auth;
CREATE DATABASE notes;
