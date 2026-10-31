# Function: fileStore()

```ts
function fileStore(dir): CredentialStore;
```

Keeps credentials in files under `dir`, one `<env>-<0xaddr>.json` per key. Files are
written with mode `0o600`, and `dir` is created with mode `0o700` if it is missing (an
existing directory is left as it is).

`dir` should be private to the user. The file modes keep other local users from
reading the files, but a user who can write to `dir` could still delete or replace
them. Windows ignores `mode`, so the directory's ACLs apply there. A leading `~` is not
expanded: callers must do that themselves. A relative `dir` is resolved against the
working directory once, when the store is created.

- `set` checks the value against the `StoredCredentials` shape first and stores only
  the known fields (a bad value throws a `ValidationError` before anything touches the
  disk). It then writes a unique tmp file in `dir`, flushes it to disk, and renames it
  over the target, so a reader sees the old value or the new one and never half of
  it. Two concurrent `set`s on a key leave one of the two values.
- `get` returns `undefined` for a missing file, and also for a file that is not JSON
  or does not match the `StoredCredentials` shape. That file is left in place (the
  next `set` replaces it) and nothing is logged. Fields it does not know are dropped.
- `set` and `delete` also try to remove tmp files of the same key that are more than a
  minute old (a crash can leave them). Failures there are ignored.
- Any other fs failure (for example `EACCES`) throws an `XoError` with code
  `credential_store_unavailable`. Its message names only the errno, for example
  `credential store unavailable: read failed (EACCES)`.
- A key that is not exactly `<env>:<0x, 40 lower-case hex digits>` throws a
  `ValidationError` before any fs call.

Sharing one `dir` between processes that run at the same time is not supported: a
session serializes its reads and writes within its own process only, so two processes
can overwrite each other's record (and each then mints its own key).

## Parameters

| Parameter | Type |
| ------ | ------ |
| `dir` | `string` |

## Returns

[`CredentialStore`](../../interfaces/CredentialStore.md)
