# Type Alias: RequestOptions

```ts
type RequestOptions = object;
```

Options of one read: how long each attempt may take, how often it is retried, and a signal
that cancels it. Calls that change something take none of them: aborting one could not undo
it. Orders, cancels, on-chain transactions, deposits and withdrawals are sent once and never
retried. Deleting the client's own API key (when it closes, rotates its key or ends
authentication) is retried, since deleting it twice is harmless.

## Example

```ts
const controller = new AbortController();
const options: RequestOptions = { signal: controller.signal, timeout: 5_000, retries: 0 };
```

## Properties

### retries?

```ts
optional retries?: number;
```

How many times a read is tried again after a network error or a 429, 502, 503 or 504: a
whole number from 0 to 5. Defaults to 2. The wait between attempts grows from 250 ms up to
2 s. When the service asks for a wait (`Retry-After`), it is waited up to 5 s; a longer one
is not waited, and the error goes back to you with `retryAfter` set.

***

### signal?

```ts
optional signal?: AbortSignal;
```

Cancels the call: every attempt, the waits between attempts and reading the answer. The
credentials a request needs are not cut short: the signal is checked again once they are
ready, before anything is sent. Aborting rejects with a `RequestAbortedError` whose `cause`
is the signal's reason.

***

### timeout?

```ts
optional timeout?: number | false;
```

How long each attempt may take, in whole milliseconds, before it fails with a
`TimeoutError`. `false` sets no limit. Defaults to 30 000 (30 s).
