import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { UserInputError, XoError } from '../core/errors';
import {
  type CredentialStore,
  parseStoredCredentials,
  StoredCredentialsSchema,
} from './store';

// Node only. This file is exported from `src/node.ts` and must stay out of the import
// graph of `src/index.ts`.

/** The only key shape a file name is built from, as `credentialKey` produces it. */
const KEY_PATTERN = /^[a-z0-9-]+:0x[0-9a-f]{40}$/;

/** A tmp file older than this is left over from a crash and is removed. */
const STALE_TMP_MS = 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `<env>:<0xaddr>` becomes `<env>-<0xaddr>.json`. Any other key is rejected. */
function fileNameFor(key: unknown): string {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
    // Names the field only. The key may be a path, so it is not repeated.
    throw new UserInputError(
      'key must look like "<env>:<lower-case 0x address>"',
    );
  }
  return `${key.replace(':', '-')}.json`;
}

/** The errno name of a failed fs call (`EACCES`), or `UNKNOWN`. Nothing else is kept. */
function errnoOf(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)
    ? code
    : 'UNKNOWN';
}

/**
 * The error for an fs failure other than "no such file". The message holds the errno
 * name and nothing else. The fs error is not kept as `cause`, because its message and
 * `path` property carry the file path.
 */
function unavailable(
  operation: 'read' | 'write' | 'delete',
  error: unknown,
): XoError {
  return new XoError(
    `credential store unavailable: ${operation} failed (${errnoOf(error)})`,
    { code: 'credential_store_unavailable' },
  );
}

/**
 * Best effort: removes the `.<name>.<uuid>.tmp` files of one key that are older than
 * {@link STALE_TMP_MS}. Every error is ignored and nothing is logged.
 */
async function sweepStaleTmp(dir: string, name: string): Promise<void> {
  try {
    const prefix = `.${name}.`;
    const now = Date.now();
    for (const entry of await readdir(dir)) {
      if (
        !entry.startsWith(prefix) ||
        !entry.endsWith('.tmp') ||
        !UUID.test(entry.slice(prefix.length, -'.tmp'.length))
      ) {
        continue;
      }
      try {
        const path = join(dir, entry);
        if (now - (await lstat(path)).mtimeMs > STALE_TMP_MS) {
          await unlink(path);
        }
      } catch {
        // Someone else may have removed it, or it is not ours to remove.
      }
    }
  } catch {
    // The directory may be missing or unreadable. The sweep is optional.
  }
}

/**
 * Keeps credentials in files under `dir`, one `<env>-<0xaddr>.json` per key. Files are
 * written with mode `0o600`, and `dir` is created with mode `0o700` if it is missing (an
 * existing directory is left as it is).
 *
 * `dir` should be private to the user. The file modes keep other local users from
 * reading the files, but a user who can write to `dir` could still delete or replace
 * them. Windows ignores `mode`, so the directory's ACLs apply there. A leading `~` is not
 * expanded: callers must do that themselves. A relative `dir` is resolved against the
 * working directory once, when the store is created.
 *
 * - `set` checks the value against the `StoredCredentials` shape first and stores only
 *   the known fields (a bad value throws a `UserInputError` before anything touches the
 *   disk). It then writes a unique tmp file in `dir`, flushes it to disk, and renames it
 *   over the target, so a reader sees the old value or the new one and never half of
 *   it. Two concurrent `set`s on a key leave one of the two values.
 * - `get` returns `undefined` for a missing file, and also for a file that is not JSON
 *   or does not match the `StoredCredentials` shape. That file is left in place (the
 *   next `set` replaces it) and nothing is logged. Fields it does not know are dropped.
 * - `set` and `delete` also try to remove tmp files of the same key that are more than a
 *   minute old (a crash can leave them). Failures there are ignored.
 * - Any other fs failure (for example `EACCES`) throws an `XoError` with code
 *   `credential_store_unavailable`. Its message names only the errno, for example
 *   `credential store unavailable: read failed (EACCES)`.
 * - A key that is not exactly `<env>:<0x, 40 lower-case hex digits>` throws a
 *   `UserInputError` before any fs call.
 *
 * Sharing one `dir` between processes that run at the same time is not supported: a
 * session serializes its reads and writes within its own process only, so two processes
 * can overwrite each other's record (and each then mints its own key).
 */
export function fileStore(dir: string): CredentialStore {
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new UserInputError('dir must be a non-empty path');
  }
  const base = resolve(dir);

  return {
    persistent: true,

    async get(key) {
      const path = join(base, fileNameFor(key));
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') {
          return undefined;
        }
        throw unavailable('read', error);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return undefined;
      }
      const parsed = StoredCredentialsSchema.safeParse(json);
      return parsed.success ? parsed.data : undefined;
    },

    async set(key, value) {
      const name = fileNameFor(key);
      // Before any fs call and outside the fs `try`: a bad value is the caller's error,
      // not an unavailable store. The parsed copy holds plain strings and arrays, so
      // `JSON.stringify` cannot fail on it.
      const body = JSON.stringify(parseStoredCredentials(value));
      const target = join(base, name);
      const tmp = join(base, `.${name}.${randomUUID()}.tmp`);
      try {
        await mkdir(base, { recursive: true, mode: 0o700 });
        // `wx`: never write into a file that already exists.
        const handle = await open(tmp, 'wx', 0o600);
        try {
          await handle.writeFile(body);
          // Flush to disk before the rename, so a crash cannot leave an empty target.
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmp, target);
      } catch (error) {
        await unlink(tmp).catch(() => undefined);
        throw unavailable('write', error);
      }
      await sweepStaleTmp(base, name);
    },

    async delete(key) {
      const name = fileNameFor(key);
      try {
        await unlink(join(base, name));
      } catch (error) {
        if (errnoOf(error) !== 'ENOENT') {
          throw unavailable('delete', error);
        }
      }
      await sweepStaleTmp(base, name);
    },
  };
}
