# Markets and prices

## Create a client with no key

`createPublicClient()` reads public data only. It returns at once and sends nothing until you make
a call. Make one when your server starts and share it between requests.

<!-- snippet: docs/snippets/markets.ts#client -->
```ts
const client = createPublicClient();
```

Public reads are rate limited per IP address. Cache what you show and serve your users from your
server. See [Orderbook API rate limits](/api-reference/rate-limits).

## List markets

<!-- snippet: docs/snippets/markets.ts#list-markets -->
```ts
const page = await client
  .listMarkets({ status: 'active', sort: 'volume', pageSize: 10 })
  .firstPage();

for (const market of page.items) {
  console.log(
    `${market.id}: ${market.question} (volume ${market.metrics.volume})`,
  );
}
```

`listMarkets` lists the markets that trade on the order book and have two outcomes. It lists open
markets unless you pass `status: 'closed'` or `'resolved'`. `sort` is `volume`, `created`,
`endDate` or `liquidity`, and `order` is `desc` unless you pass `'asc'`. The `volume` order puts
high-volume markets first, in XO's own ranking, which does not always match the order of the
`metrics.volume` you print. A page holds up to 50
markets, and it can hold fewer than `pageSize`, since a row that is not such a market is left
out. The other filters are in
[`ListMarketsRequest`](reference/client/type-aliases/ListMarketsRequest.md).

A market in a list has only what the list carries. Its tick size, its prices and its fee and
rewards fields are `null` until you `fetchMarket` it.

## Read the next page

`listMarkets` returns a `Paginated` list. Nothing is requested until you read it: `firstPage()`
reads one page, and `for await` walks them one request at a time. Every `list*` method works this
way.

<!-- snippet: docs/snippets/markets.ts#pagination -->
```ts
const markets = client.listMarkets({ status: 'active', pageSize: 5 });

let pageCount = 0;
let cursor: string | undefined;

for await (const page of markets) {
  pageCount += 1;
  console.log(`Page ${pageCount}`);
  for (const market of page.items) {
    console.log(`  ${market.id}: ${market.question}`);
  }
  cursor = page.nextCursor;
  if (pageCount === 3) {
    break;
  }
}
```

A page has `items`, `hasMore` and, while there is more, a `nextCursor`. A cursor is opaque: keep it
exactly as given. `from(cursor)` carries on from it, even in another process.

<!-- snippet: docs/snippets/markets.ts#pagination-cursor -->
```ts
const next = await markets.from(cursor).firstPage();
console.log(
  `Page 4 has ${next.items.length} market(s); more after it: ${next.hasMore}`,
);
```

A list can be read only to a fixed depth. The last page it reaches says `limitReached: true`, and
asking for more throws `PaginationLimitError`: narrow the list with filters to reach the rest.

## Get one market

`fetchMarket` takes exactly one of `id`, `slug`, `url` (the link of the market's page on XO's
website) or `conditionId`. It reads the market from four places at once and joins them, so it is
the way to get the fields a list leaves `null`.

<!-- snippet: docs/snippets/markets.ts#fetch-market -->
```ts
const bySlug = await client.fetchMarket({ slug: listed.slug });
const byUrl = await client.fetchMarket({
  url: `https://xo.market/markets/${listed.slug}`,
});
const byId = await client.fetchMarket({ id: listed.id });
```

<!-- snippet: docs/snippets/markets.ts#market-fields -->
```ts
console.table({
  conditionId: byId.conditionId,
  yesToken: byId.outcomes.yes.tokenId,
  noToken: byId.outcomes.no.tokenId,
  yesPrice: byId.outcomes.yes.price,
  tickSize: byId.trading.minimumTickSize,
  minimumOrderSize: byId.trading.minimumOrderSize,
  endDate: byId.state.endDate,
});
```

| Id | Looks like | Use it for |
| --- | --- | --- |
| `id` | `12345` | `fetchMarket`, and `marketId` in `listTrades`, `fetchUserPnl` and the `activity` topic. |
| `slug` | Words joined by hyphens | The market's URL on XO. |
| `conditionId` | `0x` and 64 hex digits | `market` specs of `subscribe`, `cancelMarketOrders`, `mergePositions`, `redeemPositions` and `fetchMarketCapacity`. |
| `outcomes.yes.tokenId`, `outcomes.no.tokenId` | A long decimal string | `assetId` in prices, books and orders. Always pass them as strings. |

A market has two outcomes, `yes` and `no`. Each has a `label`, the market's own title for it. It
is usually `YES` or `NO`, but a market can word it differently, so show the label to your users.

## Check that a market takes orders

`state.active` and `state.acceptingOrders` are what XO reports. A market can read active after it
expired, or without being set up on chain, and orders on it are accepted and then fail to settle.
`fetchMarketTradability` checks the order book, the end time and three things on chain, so call it
when you choose a market, not for every row of a list.

<!-- snippet: docs/snippets/markets.ts#tradability -->
```ts
const { ok, reasons } = await client.fetchMarketTradability({ conditionId });
console.log(ok ? 'tradable' : `not tradable: ${reasons.join(', ')}`);
```

`reasons` has one stable code for each failed check: `orderbook_inactive`, `expired`,
`expiry_unknown`, `chain_unchecked`, `not_prepared`, `already_resolved` or
`not_registered_on_exchange`. The verdict is a snapshot, not a guarantee.

## Read prices

Read the YES token. Its prices are the market's, and a YES midpoint of `0.68` reads as a 68 %
chance.

<!-- snippet: docs/snippets/markets.ts#prices -->
```ts
const [orderBook, buyPrice, midpoint, spread, lastTrade] = await Promise.all([
  client.fetchOrderBook({ assetId }),
  client.fetchPrice({ assetId, side: OrderSide.BUY }),
  client.fetchMidpoint({ assetId }),
  client.fetchSpread({ assetId }),
  client.fetchLastTradePrice({ assetId }),
]);

console.table({
  market: market.question,
  assetId,
  bids: orderBook.bids.length,
  asks: orderBook.asks.length,
  buyPrice: buyPrice ?? 'none',
  midpoint: midpoint ?? 'none',
  spread: spread ?? 'none',
  lastTradePrice: lastTrade?.price ?? 'none',
  lastTradeSide: lastTrade?.side ?? 'none',
});
```

`fetchPrice` reads the best price on one side of the book: the best bid for `OrderSide.BUY`, and
the best ask for `OrderSide.SELL`. With nothing to report, these reads answer `null`, never a
price of 0:

| Call | `null` means |
| --- | --- |
| `fetchMidpoint` | A side of the book is empty. Show "no price", not 0 %. |
| `fetchPrice` | That side of the book is empty. |
| `fetchSpread` | A side of the book is empty. |
| `fetchLastTradePrice` | The token has not traded yet. |

Prices are decimal strings, and one price can print as `"0.550"` or `"0.55"`. Parse them to
compare.

## Price many markets at once

Take the YES token of each listed market and price the whole page in one request.
`fetchMidpoints`, `fetchPrices`, `fetchSpreads`, `fetchLastTradePrices` and `fetchOrderBooks` all
take a list of tokens.

<!-- snippet: docs/snippets/markets.ts#list-prices -->
```ts
const assetIds = page.items.flatMap(
  (market) => market.outcomes.yes.tokenId ?? [],
);
const midpoints = await client.fetchMidpoints({ assetIds });

console.table(
  page.items.map((market) => ({
    slug: market.slug,
    yes: midpoints[market.outcomes.yes.tokenId ?? ''] ?? 'no price',
  })),
);
```

`fetchMidpoints`, `fetchPrices` and `fetchSpreads` return an object keyed by token id, with an
entry for every token you ask for: `null` where there is no price, as for one token, and for a
token the order book does not know. `fetchLastTradePrices` returns a list that leaves out a token
that has not traded, so match its rows by `assetId`.

## Read the order book

<!-- snippet: docs/snippets/markets.ts#book -->
```ts
const book = await client.fetchOrderBook({ assetId });

console.log(`${market.question}: tick ${book.minimumTickSize}`);
console.log('Best bids, best first');
console.table(book.bids.slice(-5).reverse());
console.log('Best asks, best first');
console.table(book.asks.slice(-5).reverse());
```

Each side lists its best price last, so the best bid is `bids.at(-1)` and the best ask is
`asks.at(-1)`. The book also carries the tick size and the smallest order. To keep a book current,
stream it: see [Live data](realtime.md).

## YES and NO

One YES share and one NO share pay out 1 USDC together, so a NO price of `q` is a YES price of
`1 - q`. Every order shows on both books, mirrored, so the YES book alone is the whole market.
If you quote around the book, leave your own orders out of both books.

## Events and more reads

Some markets belong to an event, such as one match with a market for each result. `fetchEvent`
reads an event with its markets. A market reached this way has a `groupItemTitle`, its label
within the event. On a market that stands alone, or that you read from a list, it is `null`.

<!-- snippet: docs/snippets/markets.ts#event-markets -->
```ts
const event = await client.fetchEvent({ slug });
for (const market of event.markets ?? []) {
  console.log(`${market.groupItemTitle ?? market.slug}: ${market.question}`);
}
```

| Method | Reads |
| --- | --- |
| `listEvents`, `fetchEvent`, `listSubevents` | Events, one event with its markets, and the sub-events of an event, such as one half of a match. |
| `listSeries`, `fetchSeries` | Series of events, such as a tournament. |
| `listCategories`, `listSubcategories` | The categories markets are filed under. |
| `listBrowseItems` | The cards of XO's market page, in its trending order. |
| `listMarkets({ eventId })`, `listMarkets({ seriesId })` | The markets of an event or a series. |
| `listTrades({ marketId })` | The latest fills of one market. |
| `listPriceHistory` | The recent trade prices of one token. |

## Liquidity rewards

Some markets pay USDC to the makers whose resting orders score. `listRewardPools` lists them, with
the daily pool and the terms for an order to score.

<!-- snippet: docs/snippets/markets.ts#rewards-markets -->
```ts
const { items } = await client.listRewardPools().firstPage();

const rows = items.flatMap((pool) =>
  pool.programmes
    .filter((programme) => programme.currency === 'USDC' && programme.active)
    .map((programme) => ({
      market: pool.market?.slug ?? pool.conditionId,
      usdcPerDay: programme.dailyPool ?? 'n/a',
      minShares: programme.terms.minOrderSize ?? 'n/a',
      maxCentsFromMid: programme.terms.maxDistanceCents ?? 'n/a',
      ends: programme.endsAt ?? 'n/a',
    })),
);

console.table(rows);
```

`fetchMarketRewards` reads one market's programme, and `fetchUserRewards` what a wallet has earned.
The rest are in the [API reference](reference/client/interfaces/PublicClient.md).
