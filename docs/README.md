# TypeScript SDK

`@xomarket/client` is XO's official TypeScript SDK for market data, real-time subscriptions,
trading and moving funds. It runs on your server, with Node 22 or later or Bun.

<!-- cards: github, npm -->
- **[GitHub](https://github.com/xo-market/xo-ts-sdk)**: The SDK's source.
- **[npm](https://www.npmjs.com/package/@xomarket/client)**: The `@xomarket/client` package.

## Quickstart

Install the SDK and viem:

<!-- code-group -->
<!-- snippet: none -->
```sh npm
npm install @xomarket/client viem
```

<!-- snippet: none -->
```sh pnpm
pnpm add @xomarket/client viem
```

<!-- snippet: none -->
```sh yarn
yarn add @xomarket/client viem
```

<!-- snippet: none -->
```sh bun
bun add @xomarket/client viem
```

In TypeScript, set `moduleResolution` to `NodeNext`, `Node16` or `Bundler`. Signers are in
`@xomarket/client/viem`, `fileStore` in `/node`, and low-level signing in `/signing`.

Then create a public client and list some markets. Reading public data needs no key.

<!-- snippet: docs/snippets/sdk-quickstart.ts#quickstart -->
```ts
import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();

const page = await client.listMarkets({ pageSize: 5 }).firstPage();

for (const market of page.items) {
  console.log(`${market.id}: ${market.question}`);
}
```

More runnable scripts are in the [examples folder](../examples/scripts/README.md).

## Pagination

Every `list*` method returns pages the same way. Loop over them with `for await`, or save
`nextCursor` and carry on later with `from(cursor)`.

<!-- snippet: docs/snippets/sdk-pagination.ts#pagination -->
```ts
const markets = client.listMarkets({ pageSize: 50 });

for await (const page of markets) {
  console.log(`${page.items.length} markets`);
}

const first = await markets.firstPage();
const next = await markets.from(first.nextCursor).firstPage();
```

## Types

Every method returns typed models. Ids and amounts are strings, so no precision is lost.

<!-- snippet: docs/snippets/sdk-types.ts#types -->
```ts
import type {
  ConditionId,
  DecimalString,
  Market,
  OrderBook,
  TokenId,
} from '@xomarket/client';
```

## Error handling

Every method has an error guard that tells its errors apart from yours.

<!-- snippet: docs/snippets/sdk-errors.ts#errors -->
```ts
import { ListMarketsError, RateLimitError } from '@xomarket/client';

try {
  await client.listMarkets({ pageSize: 5 }).firstPage();
} catch (error) {
  if (!ListMarketsError.isError(error)) {
    throw error;
  }
  if (error instanceof RateLimitError) {
    console.log(`Rate limited. Try again in ${error.retryAfter} ms`);
  } else {
    console.log(`${error.code}: ${error.message}`);
  }
}
```

A refused order is not an error: it comes back with `ok: false`. See [Errors](errors.md) for every
code.

## Wallet integrations

Trading and reading your account need a secure client. Create one with
`createSecureClient({ signer })`. It signs in before it returns.

<!-- code-group -->
<!-- snippet: docs/snippets/sdk-wallet-key.ts#wallet-private-key -->
```ts Private key
import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';

const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK ?? ''),
});
```

<!-- snippet: docs/snippets/sdk-wallet-viem.ts#wallet-viem -->
```ts viem account
import { createSecureClient } from '@xomarket/client';
import { signerFrom } from '@xomarket/client/viem';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.XO_PK as `0x${string}`);
const client = await createSecureClient({ signer: signerFrom(account) });
```

<!-- snippet: docs/snippets/sdk-wallet-smart.ts#wallet-smart -->
```ts Smart wallet
import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';

const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK ?? ''),
  wallet: '0xYourSmartWalletAddress',
});
```

Keep the key on your server, never in your code. See [Wallets and authentication](authentication.md) for
saved keys, smart wallets and closing a client.

## Realtime subscriptions

`subscribe` streams order books, trades, your orders and your positions.

<!-- snippet: docs/snippets/sdk-realtime.ts#realtime -->
```ts
const stream = await client.subscribe([
  { topic: 'market', assetIds: [assetId] },
]);

for await (const event of stream) {
  if (event.type === 'book') {
    console.log(`${event.bids.length} bids, ${event.asks.length} asks`);
  }
}
```

## Next steps

<!-- cards: chart-line, bolt, rocket, key -->
- **[Read market data](markets.md)**: Markets, prices and order books.
- **[Stream real-time data](realtime.md)**: Books, trades, orders and positions.
- **[Place your first order](quickstart.md)**: From a key to a trade in five steps.
- **[Wallets and authentication](authentication.md)**: Keys, smart wallets and saved credentials.
