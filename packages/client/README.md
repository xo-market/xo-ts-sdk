# @xomarket/client

The TypeScript SDK for XO Market. Bring XO markets into your product: from your server, it reads
markets and live prices, trades an account whose key you hold, and handles the deposits,
withdrawals and on-chain steps around trading. Market makers use it to quote both sides of a
market, unattended, for hours.

Runs on a server: Node 22+ or Bun. Browser use isn't supported yet.

> **This is XO mainnet: the money is real.** The SDK runs on XO's network, and the USDC and the
> orders are real. Use a key made for this, for an account that holds only what you mean to risk.
> On-chain actions are gas-free for a plain wallet and a smart wallet (`wallet: '0x…'`) alike:
> XO's sponsor pays the gas.

## Install

```sh
npm install @xomarket/client viem
```

The SDK depends on a compatible viem 2.x (`^2.57.7`). Install viem next to it, as above, so your
project and the SDK share one copy of viem: two copies make viem's types, such as an account you
pass to `signerFrom`, not line up. Any viem 2.x from 2.57.7 on works.

The package ships ESM and CommonJS builds with types.

## Quickstart

Public reads need no wallet and no key:

```ts
import { createPublicClient } from '@xomarket/client';

// No signer and no key: a client for public reads (markets, prices, books, the live book).
const client = createPublicClient();

// The first five open markets.
const page = await client.listMarkets({ pageSize: 5 }).firstPage();

// Each market carries its YES token, so one request prices the whole page.
const assetIds = page.items.flatMap(
  (market) => market.outcomes.yes.tokenId ?? [],
);
const midpoints = await client.fetchMidpoints({ assetIds });

for (const market of page.items) {
  // null when a side of the book is empty: there is no price to show.
  const yes = midpoints[market.outcomes.yes.tokenId ?? ''] ?? 'no price';
  console.log(`${market.slug}: YES ${yes}`);
}
```

To trade, sign in with a wallet key of your own. Keep it out of your code and your shell history
(`read -rs XO_PK && export XO_PK` reads it without echoing it):

```ts
import { createSecureClient } from '@xomarket/client';
import { fileStore } from '@xomarket/client/node';
import { privateKey } from '@xomarket/client/viem';

// It signs in when it is created: one call gets both credentials, the API key and the
// order book's.
const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK!),
  store: fileStore('./.xo'), // add .xo to your .gitignore
});

console.log('signed in as', client.wallet);

await client.close();
```

The first sign-in makes the key an XO account. The
[Quickstart](https://docs.xo.market/typescript-sdk/quickstart) goes on from there: deposit USDC,
set up the account, place one small order that rests on the book, and cancel it.

## Entry points

| Import | What it holds |
| --- | --- |
| `@xomarket/client` | `createPublicClient`, `createSecureClient`, the enums, every error class and the types. Nothing in it needs Node. |
| `@xomarket/client/viem` | `privateKey` and `signerFrom`, the signers for a private key or a viem account. |
| `@xomarket/client/node` | `fileStore`, the credential store that keeps credentials in files, and `installShutdownHooks`. |
| `@xomarket/client/signing` | The pure signing kit: order, cancel and login typed data, request signatures, smart wallet signature wrapping. For advanced use. |

## Documentation

The documentation is on [docs.xo.market](https://docs.xo.market/typescript-sdk/overview):

- [Overview](https://docs.xo.market/typescript-sdk/overview)
- [Quickstart](https://docs.xo.market/typescript-sdk/quickstart)
- [Markets and prices](https://docs.xo.market/typescript-sdk/markets)
- [Wallets and sign-in](https://docs.xo.market/typescript-sdk/authentication)
- [Production checklist](https://docs.xo.market/typescript-sdk/production)
- [SDK direction](https://docs.xo.market/typescript-sdk/sdk-direction)
- [Errors](https://docs.xo.market/typescript-sdk/errors)
- [API reference](https://docs.xo.market/typescript-sdk/reference/overview)

Found a problem with the SDK? [Open an issue](https://github.com/xo-market/xo-ts-sdk/issues). For
anything about your XO account, write to gm@xo.market.

## License

MIT. See [LICENSE](https://github.com/xo-market/xo-ts-sdk/blob/main/LICENSE).
