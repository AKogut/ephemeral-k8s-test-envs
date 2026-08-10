import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * scrypt from `node:crypto` rather than bcrypt: it is a memory-hard KDF that
 * ships with the runtime, which keeps the production image free of a native
 * dependency that exists only to hash passwords.
 *
 * `costLog2` is configurable so CI can drop it — hashing at the production cost
 * in every one of ~70 API tests would dominate the suite's runtime and tell us
 * nothing about the code under test.
 */
function params(costLog2: number): { N: number; r: number; p: number; maxmem: number } {
  const N = 2 ** costLog2;
  const r = 8;
  const p = 1;
  // Node's default maxmem (32 MiB) is too small once N goes past 2^14.
  return { N, r, p, maxmem: 256 * N * r * 2 };
}

export interface PasswordHash {
  hash: string;
  salt: string;
}

export async function hashPassword(password: string, costLog2: number): Promise<PasswordHash> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, params(costLog2));
  return { hash: derived.toString('base64'), salt: salt.toString('base64') };
}

export async function verifyPassword(
  password: string,
  stored: PasswordHash,
  costLog2: number,
): Promise<boolean> {
  const salt = Buffer.from(stored.salt, 'base64');
  const expected = Buffer.from(stored.hash, 'base64');
  const derived = await scryptAsync(password, salt, expected.length, params(costLog2));
  // Lengths always match here, but timingSafeEqual throws if they ever do not.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
