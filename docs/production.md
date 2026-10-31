# Production checklist

> [!WARNING]
> Mainnet is real money. Give the server a wallet of its own, funded with only what it needs to
> trade.

## Keep credentials in a persistent store

With `fileStore`, the client keeps one 90-day API key across restarts, so a restart signs in
without a wallet signature. `label` goes into the key's name, so you can tell your servers apart.

<!-- snippet: docs/snippets/production.ts#production-client -->
```ts
const client = await createSecureClient({
  signer: privateKey(key),
  store: fileStore('/var/lib/my-bot/xo'),
  label: 'my-bot',
  shutdownHooks: false,
});
```

Keep the directory private to the service's user, out of git and out of shared backups. Two
processes must not share one directory at the same time.

## Stay under the 10-key limit

An account holds at most 10 active API keys. When they are all in use, creating a client fails with
`api_key_limit_reached`.

- Without a persistent store, every start signs in for a new 1-day key.
- Deleting a store leaves its key active until it expires, up to 90 days.
- Every machine with its own store holds one key.

To list, replace or revoke keys, see [Wallets and sign-in](authentication.md).

## Shut down cleanly

Cancel the orders that must not rest, then close the client. Once `close()` is called the client
places no new orders, so cancel first.

<!-- snippet: docs/snippets/production.ts#stop-cancel -->
```ts
try {
  const cancelled = await client.cancelAll().catch((error: unknown) => {
    log(`cancelAll failed: ${describe(error)}. Sending it once more`);
    return client.cancelAll();
  });
  log(`cancelAll canceled ${cancelled.canceled.length} order(s)`);
} catch (error) {
  log(`cancelAll FAILED: ${describe(error)}. Check your open orders!`);
  code = 1;
}
await client.close();
```

A `cancelAll()` that failed is sent once more: nothing places orders by then, so a second one only
cancels what is still open. With `shutdownHooks: false`, run this from your own SIGINT and SIGTERM
handler. Call `close()`, not `endAuthentication()`: the order book key is shared by every process
that trades with the wallet. See [Wallets and sign-in](authentication.md).

## Cancel orders if your server stops

A heartbeat is a dead-man switch. Once the account has one counted beat, XO cancels every open
order of the account, in every market, when no counted beat arrives for 30 seconds.

> [!WARNING]
> One counted beat arms this for the whole account, and nothing disarms it: stopping the heartbeat
> does not. Do not run it on a wallet you also trade by hand, since the orders you place later, and
> the ones you place on the XO website, are cancelled too.

<!-- snippet: docs/snippets/production.ts#heartbeat -->
```ts
const heartbeat = client.startOrderHeartbeat({
  onMissed: (error) => console.warn(`Heartbeat missed: ${error.code}`),
});
```

- It beats every 10 seconds unless you set `intervalMs`. Each beat that does not count reaches
  `onMissed`, and the heartbeat goes on. When misses last for 30 seconds the orders are cancelled,
  so stop quoting.
- It covers the whole account, including orders placed by other processes or on the XO website.
- `heartbeat.stop()` does not turn the switch off. Orders still open 30 seconds after the last
  beat are cancelled, and so are orders you place after `stop()`.
- It is a safety net. Still cancel your orders on purpose when you stop.
- One heartbeat runs per client, and `close()` stops it. Its timers never keep the process alive.
  `sendOrderHeartbeat()` sends a single beat.

## Set the limits of a read

Reads take a last argument, `{ timeout, retries, signal }`, for that call alone. A call that
changes something takes none, and aborting it could not undo it. Orders, cancels, on-chain
transactions and payments are sent once and never retried. Deleting the client's own API key,
when it closes, rotates its key or ends authentication, is retried: deleting it twice is
harmless. A cancel whose answer is lost throws with `mayHaveLanded: true`: read your open orders
before you send it again.

<!-- snippet: docs/snippets/production.ts#request-options -->
```ts
const book = await client.fetchOrderBook(
  { assetId },
  { timeout: 5_000, retries: 0, signal },
);
```

- `timeout` is how long each attempt may take, in milliseconds: 30 000 by default, or `false` for
  no limit. A late attempt fails with `TimeoutError`.
- `retries` is how often a read is tried again after a network error or a 429, 502, 503 or 504:
  0 to 5, 2 by default.
- When a service asks for a wait with `Retry-After`, the SDK waits up to 5 seconds. A longer wait
  is not slept, and the error goes back to you with `retryAfter` in milliseconds: a `RateLimitError`
  for a 429, and for a 5xx the `RequestRejectedError` of that answer.
- `signal` cancels the call: every attempt, the waits between them and reading the answer. The
  credentials a request needs are not cut short: the signal is checked again once they are ready,
  before anything is sent. The call then fails with `RequestAbortedError`, and `cause` is the
  signal's reason.

## Keep secrets out of logs and shell history

Never put a key on a command line, such as `XO_PK=0x… node server.js`. The shell saves it in
its history. Read it without echo, or keep it in a file:

<!-- snippet: none -->
```sh
read -rs XO_PK && export XO_PK    # paste the key: not echoed, not in the history
node --env-file=.env server.js    # or a gitignored .env file (mode 0600)
```

The SDK's errors and `JSON.stringify(client)` are safe to log. Never log the result of
`exportCredentials()`, a store's values or a signer's key.

> [!WARNING]
> Never turn on socket.io-client's debug logging (`DEBUG=socket.io-client:*` or `DEBUG=*`) in a
> process that holds a real key. It prints the API key to stderr in clear text.

## Watch rate limits

The SDK retries a read that gets a 429, but never a placement. Pass `onRateLimitUpdate` to either
factory to see how much headroom each response leaves.

<!-- snippet: docs/snippets/production.ts#rate-limit -->
```ts
const client = createPublicClient({
  onRateLimitUpdate: (update) => {
    if (update.remaining === 0) {
      console.warn(`${update.service} rate limit reached on ${update.path}`);
    }
  },
});
```

The limits are on [Orderbook API rate limits](/api-reference/rate-limits) and
[Data API rate limits](/data-api-reference/rate-limits).
