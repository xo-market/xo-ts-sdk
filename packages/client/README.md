# @xomarket/client

The TypeScript SDK for XO Market. Read markets and prices, trade, and move funds from your
server, with Node 22 or later or Bun.

> **XO runs on mainnet, so the money is real.** Trade with a wallet that holds only what you can
> afford to lose.

## Install

```sh
npm install @xomarket/client viem
```

## Example

Reading markets needs no key:

```ts
import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();
const page = await client.listMarkets({ pageSize: 5 }).firstPage();

for (const market of page.items) {
  console.log(`${market.id}: ${market.question}`);
}
```

To trade, follow [Place your first order](https://docs.xo.market/typescript-sdk/quickstart).

## Documentation

- [TypeScript SDK](https://docs.xo.market/typescript-sdk/overview)
- [Place your first order](https://docs.xo.market/typescript-sdk/quickstart)
- [Market data](https://docs.xo.market/typescript-sdk/markets)
- [Place orders](https://docs.xo.market/typescript-sdk/place-orders)
- [Errors](https://docs.xo.market/typescript-sdk/errors)
- [API reference](https://docs.xo.market/typescript-sdk/reference/overview)

Found a problem with the SDK? [Open an issue](https://github.com/xo-market/xo-ts-sdk/issues). For
anything about your XO account, write to gm@xo.market.

## License

MIT. See [LICENSE](https://github.com/xo-market/xo-ts-sdk/blob/main/LICENSE).
