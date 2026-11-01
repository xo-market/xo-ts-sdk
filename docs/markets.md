# Markets and prices

Read markets, prices and order books. None of this needs a key.

## Create a client

<!-- snippet: docs/snippets/markets.ts#client -->
```ts
const client = createPublicClient();
```

Create one client when your app starts and reuse it. Public reads are rate limited per IP
address, so cache what you show your users. See [rate limits](/api-reference/rate-limits).

## List markets

<!-- snippet: docs/snippets/markets.ts#list-markets -->
```ts
const page = await client
  .listMarkets({ sort: 'volume', pageSize: 10 })
  .firstPage();

for (const market of page.items) {
  console.log(`${market.id}: ${market.question}`);
}
```

`listMarkets` returns open markets. For every filter and sort order, see
[`ListMarketsRequest`](reference/client/type-aliases/ListMarketsRequest.md).

A market from a list has no prices or tick size. Fetch the market to get them.

## Read every page

Every `list*` method returns pages. Loop over them with `for await`:

<!-- snippet: docs/snippets/markets.ts#pagination -->
```ts
for await (const page of client.listMarkets({ pageSize: 50 })) {
  for (const market of page.items) {
    console.log(market.question);
  }
}
```

To read one page, call `firstPage()`. To carry on later, save `page.nextCursor` and pass it to
`from(cursor)`.

## Get one market

<!-- snippet: docs/snippets/markets.ts#fetch-market -->
```ts
const market = await client.fetchMarket({ slug });

console.log(market.question);
console.log('YES token:', market.outcomes.yes.tokenId);
console.log('Tick size:', market.trading.minimumTickSize);
```

You can look a market up by `id`, `slug`, `url` or `conditionId`. Each is used in different places:

| Field | Use it for |
| --- | --- |
| `id` | `fetchMarket`, trades and PnL |
| `slug` | The market's link on XO |
| `conditionId` | Live data, cancelling a market's orders, redeeming |
| `outcomes.yes.tokenId`, `outcomes.no.tokenId` | Prices, order books and orders, as `assetId` |

## Check that a market takes orders

<!-- snippet: docs/snippets/markets.ts#tradability -->
```ts
const { ok, reasons } = await client.fetchMarketTradability({ conditionId });
console.log(ok ? 'tradable' : `not tradable: ${reasons.join(', ')}`);
```

Call this before you trade. If `ok` is false, `reasons` says why, for example `expired`.

## Read prices

Read prices for the YES token. A midpoint of `0.68` means a 68% chance, and the NO price is
1 minus the YES price.

<!-- snippet: docs/snippets/markets.ts#prices -->
```ts
const [midpoint, bestBid, spread, lastTrade] = await Promise.all([
  client.fetchMidpoint({ assetId }),
  client.fetchPrice({ assetId, side: OrderSide.BUY }),
  client.fetchSpread({ assetId }),
  client.fetchLastTradePrice({ assetId }),
]);

console.log({ midpoint, bestBid, spread, lastTrade: lastTrade?.price });
```

A price is `null` when there is none, for example when one side of the book is empty. Show
"no price", not 0%.

## Price many markets at once

<!-- snippet: docs/snippets/markets.ts#list-prices -->
```ts
const assetIds = page.items.flatMap(
  (market) => market.outcomes.yes.tokenId ?? [],
);
const midpoints = await client.fetchMidpoints({ assetIds });

for (const assetId of assetIds) {
  console.log(assetId, midpoints[assetId] ?? 'no price');
}
```

`fetchPrices`, `fetchSpreads` and `fetchOrderBooks` take a list too.

## Read the order book

<!-- snippet: docs/snippets/markets.ts#book -->
```ts
const book = await client.fetchOrderBook({ assetId });

console.log('Best bid:', book.bids.at(-1));
console.log('Best ask:', book.asks.at(-1));
```

Each side is sorted with the best price last.

## Events

Some markets belong to an event, such as a match with one market for each result.

<!-- snippet: docs/snippets/markets.ts#event-markets -->
```ts
const event = await client.fetchEvent({ slug });

for (const market of event.markets ?? []) {
  console.log(`${market.groupItemTitle ?? market.slug}: ${market.question}`);
}
```

`listEvents`, `listSeries`, `listCategories` and `listBrowseItems` read the rest of XO's catalog.

## Liquidity rewards

Some markets pay USDC to makers whose orders rest near the midpoint.

<!-- snippet: docs/snippets/markets.ts#rewards-markets -->
```ts
const { items } = await client.listRewardPools().firstPage();

for (const pool of items) {
  for (const programme of pool.programmes) {
    console.log(
      pool.market?.slug ?? pool.conditionId,
      `${programme.dailyPool} ${programme.currency} a day`,
    );
  }
}
```

## Next steps

- [Place an order](orders.md)
- [Stream live prices](realtime.md)
- [All public reads](reference/client/interfaces/PublicClient.md)
