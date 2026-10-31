# Function: installShutdownHooks()

```ts
function installShutdownHooks(close): () => void;
```

Runs `close` (for example `session.close()`, which revokes a short-lived backend key) when
the process gets SIGINT or SIGTERM, then ends the process the way the signal would have.

On the first of the two signals both handlers are removed, `close()` is awaited for at
most 5 s (a failure is ignored), and the same signal is sent to the process again. With no
other listener left, Node then terminates with the signal's default behaviour; a second
Ctrl-C during the wait ends the process at once. A listener of your own for the same
signal is called again by the re-sent signal.

The process is found by feature detection (`globalThis.process` with `on`, `once`,
`removeListener` and `kill`). Where there is none (a browser, a worker) nothing is
installed and the function returned does nothing.

Install it once per process. `createSecureClient` installs it for you (one set per process,
for every client that holds it) when the client signs in for a 1-day API key: no
`credentials.backend`, no persistent `store`, a runtime with process signals, and
`shutdownHooks` not `false`. Call it yourself only for a client created with
`shutdownHooks: false`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `close` | () => `Promise`\<`void`\> |

## Returns

A function that removes both handlers. Calling it again does nothing.

() => `void`

## Throws

if `close` is not a function.

## Example

```ts
const client = await createSecureClient({ signer, shutdownHooks: false });
const uninstall = installShutdownHooks(() => client.close());
```
