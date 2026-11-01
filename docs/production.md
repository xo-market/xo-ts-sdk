# Production checklist

> [!WARNING]
> Mainnet is real money. Give your server a wallet of its own, funded with only what it trades.

## Keep credentials across restarts

<!-- snippet: docs/snippets/production.ts#production-client -->
```ts
const client = await createSecureClient({
  signer: privateKey(key),
  store: fileStore('/var/lib/my-bot/xo'),
  label: 'my-bot',
});
```

`fileStore` keeps one 90-day API key, so a restart reuses it. `label` goes into the key's name, so
you can tell your servers apart. Keep the folder private, and give each running process its own.

An account holds at most 10 active API keys. Without a store, every start signs in for a new one,
and once all 10 are in use, creating a client fails with `api_key_limit_reached`.

## Shut down cleanly

<!-- snippet: docs/snippets/production.ts#stop-cancel -->
```ts
try {
  await client.cancelAll();
} finally {
  await client.close();
}
```

Run this when your server stops, such as on SIGTERM. A closed client can't cancel, so cancel
first. If `cancelAll()` throws, check your open orders.

Call `close()`, not `endAuthentication()`. `endAuthentication()` deletes the order book key that
every process of the wallet shares.

## Cancel orders if your server stops

<!-- snippet: docs/snippets/production.ts#heartbeat -->
```ts
const heartbeat = client.startOrderHeartbeat({
  onMissed: (error) => console.warn(`Heartbeat missed: ${error.code}`),
});
```

Once one beat counts, XO cancels every open order of the account when no beat arrives for 30
seconds. That includes orders from other processes and the XO website, and `heartbeat.stop()` does
not turn it off. Don't use it on a wallet you also trade by hand.

## Set the limits of a read

<!-- snippet: docs/snippets/production.ts#request-options -->
```ts
const book = await client.fetchOrderBook(
  { assetId },
  { timeout: 5_000, retries: 0, signal },
);
```

- `timeout` is how long each attempt may take, in milliseconds: 30 000 by default, or `false` for
  no limit.
- `retries` is how many times a read is tried again after a network error or a 429, 502, 503 or
  504: 0 to 5, 2 by default.
- `signal` cancels the call, which then fails with `RequestAbortedError`.

Only reads take these options. Orders, cancels, on-chain transactions and payments are sent once
and never retried.

## Stay under the rate limits

Public reads are rate limited per IP address, so cache what you show your users. Open one
long-lived `user` subscription per process and share it, since each one takes one of the
account's WebSocket slots.

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

## Keep keys out of logs

Never put a key on a command line, such as `XO_PK=0x… node server.js`, since the shell saves it in
its history. Keep it in a gitignored `.env` file instead. The SDK's errors are safe to log, but
never log what `exportCredentials()` returns. Never turn on socket.io-client's debug logging
either: it prints the API key.

## Next steps

- [Wallets and sign-in](authentication.md)
- [Errors](errors.md)
- [Live data](realtime.md)
