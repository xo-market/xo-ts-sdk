# Interface: PublicClient

A client that reads public data: markets, events, order books, prices, trades, profiles and
rewards. It has no wallet, so it has no member that places an order or reads an account. A
read of a wallet takes the wallet's address as `user`.

Every read takes its request, if it has one, and then the options of the call: `{ signal,
timeout, retries }`.

## Example

```ts
const client = createPublicClient();
const page = await client.listMarkets({ pageSize: 10 }).firstPage();
for (const market of page.items) {
  const assetId = market.outcomes.yes.tokenId;
  if (assetId !== null) {
    console.log(market.question, (await client.fetchOrderBook({ assetId })).bids.at(-1));
  }
}
```

## Extended by

- [`SecureClient`](SecureClient.md)

## Methods

### closeSubscriptions()

```ts
closeSubscriptions(): Promise<void>;
```

Closes every live subscription this client opened with [subscribe](#subscribe), and returns once
their connections have closed: each handle's loop ends and its `'closed'` fires. It does
nothing when there are none, and can be called again. The client stays usable, and can
subscribe again.

#### Returns

`Promise`\<`void`\>

#### Throws

`client_closed` on a signed-in client after `close` or
  `endAuthentication`, which closed the subscriptions already. A client without a wallet
  never rejects.

#### Example

```ts
const client = createPublicClient();
await client.closeSubscriptions();
```

***

### fetchCollateralTokens()

```ts
fetchCollateralTokens(options?): Promise<CollateralToken[]>;
```

Reads the tokens that markets are paid in, such as USDC.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`CollateralToken`](../type-aliases/CollateralToken.md)[]\>

#### Throws

`invalid_request_options` for bad options, and the read
  errors when the request fails.

#### Example

```ts
const tokens = await client.fetchCollateralTokens();
console.log(tokens.map((token) => `${token.symbol} ${token.address}`));
```

***

### fetchConvictionMarket()

```ts
fetchConvictionMarket(request, options?): Promise<ConvictionMarket>;
```

Reads a market with the metadata of a conviction market: who created it and the order the
creator committed to. A market that is not a conviction market answers its `variant` with
no creator and no commitment. No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ConditionRequest`](../type-aliases/ConditionRequest.md) | The market's `conditionId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`ConvictionMarket`](../type-aliases/ConvictionMarket.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when the
  order book does not know the market.

#### Example

```ts
const market = await client.fetchConvictionMarket({ conditionId });
console.log(market.variant, market.creator, market.commitment?.status);
```

***

### fetchEvent()

```ts
fetchEvent(request, options?): Promise<Event>;
```

Reads one event with its markets: the CLOB markets with two outcomes that are placed on it
and on its sub-events, each with its label in `groupItemTitle`. The sub-events themselves are
listed by [listSubevents](#listsubevents).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchEventRequest`](../type-aliases/FetchEventRequest.md) | Name the event by `id` or `slug`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`Event`](../type-aliases/Event.md)\>

#### Throws

`invalid_input` for a request that does not name exactly one
  event, `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when
  XO has no such event.

#### Example

```ts
const event = await client.fetchEvent({ slug: 'argentina-vs-france' });
for (const market of event.markets ?? []) {
  console.log(market.groupItemTitle, market.outcomes.yes.tokenId);
}
```

***

### fetchLastTradePrice()

```ts
fetchLastTradePrice(request, options?): Promise<LastTradePrice | null>;
```

Reads the last trade of an outcome token: its price and the side of the order that took the
liquidity. It is `null` for a token that has not traded. No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`AssetRequest`](../type-aliases/AssetRequest.md) | The token's `assetId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`LastTradePrice`](../type-aliases/LastTradePrice.md) \| `null`\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and the read errors when the request fails.

#### Example

```ts
const last = await client.fetchLastTradePrice({ assetId });
console.log(last === null ? 'no trade yet' : `${last.side} at ${last.price}`);
```

***

### fetchLastTradePrices()

```ts
fetchLastTradePrices(request, options?): Promise<LastTradePriceForAsset[]>;
```

Reads the last trades of several outcome tokens in one request. A token that has not
traded is left out, so match the rows by `assetId`: the list is not in the order asked. No
credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`AssetsRequest`](../type-aliases/AssetsRequest.md) | The tokens' `assetIds`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`LastTradePriceForAsset`](../type-aliases/LastTradePriceForAsset.md)[]\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and the read errors when the request fails.

#### Example

```ts
const trades = await client.fetchLastTradePrices({
  assetIds: [yesAssetId, noAssetId],
});
console.log(trades.map((trade) => `${trade.assetId} ${trade.price}`));
```

***

### fetchMarket()

```ts
fetchMarket(request, options?): Promise<Market>;
```

Reads one market with everything joined: XO's market data, its order book, its fee policy
and its liquidity-rewards programme. That is four requests, and the only way to get the
fields a list leaves `null`.

A market with no rewards programme is not an error: its `rewards.clobRewards` is empty. A
failure of any other source is an error, so a missing field never means "the read failed".

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchMarketRequest`](../type-aliases/FetchMarketRequest.md) | Name the market by `id`, `slug`, `url` or `conditionId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

`Promise`\<[`Market`](../type-aliases/Market.md)\>

#### Throws

`invalid_input` for a request that does not name exactly one
  market, `invalid_market_url` for a link that is not a market page of XO's website,
  `invalid_request_options` for bad options; a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when XO has no such
  market; code `not_tradable_on_orderbook` for a market that has no order book (an older kind
  of market, or one the order book does not know); `market_not_binary` when the market does not
  have exactly two outcomes.

#### Example

```ts
const market = await client.fetchMarket({ url: 'https://xo.market/markets/will-it-rain' });
console.log(market.trading.minimumTickSize, market.outcomes.yes.price);
```

***

### fetchMarketRewards()

```ts
fetchMarketRewards(request, options?): Promise<MarketRewardsDetails>;
```

Reads the rewards of one market: its programme per currency, the bonus windows, the day in
progress and what the market has paid over its life.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchMarketRewardsRequest`](../type-aliases/FetchMarketRewardsRequest.md) | The market's `conditionId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`MarketRewardsDetails`](../type-aliases/MarketRewardsDetails.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when the
  market has no rewards programme.

#### Example

```ts
const rewards = await client.fetchMarketRewards({ conditionId });
console.log(rewards.programmes.map((p) => `${p.dailyPool} ${p.currency} a day`));
```

***

### fetchMarketRewardsEpoch()

```ts
fetchMarketRewardsEpoch(request, options?): Promise<MarketRewardsEpoch>;
```

Reads one UTC day of a market's rewards: for each currency the pot, the total score, how many
makers scored, what was allocated and paid, and the makers with the highest scores.

A market with no rewards programme is not an error: it reads as an empty day, with a rail per
currency, no pot (`pool` is `null`) and no makers. Use [fetchMarketRewards](#fetchmarketrewards) to tell
whether a market has a programme: it is the one that answers 404 for a market without.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchMarketRewardsEpochRequest`](../type-aliases/FetchMarketRewardsEpochRequest.md) | The market's `conditionId` and the `epoch`. See [FetchMarketRewardsEpochRequest](../type-aliases/FetchMarketRewardsEpochRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`MarketRewardsEpoch`](../type-aliases/MarketRewardsEpoch.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and the read errors.

#### Example

```ts
const day = await client.fetchMarketRewardsEpoch({ conditionId });
for (const rail of day.rails) {
  console.log(rail.currency, rail.pool, rail.makerCount);
}
```

***

### fetchMarketTradability()

```ts
fetchMarketTradability(request, options?): Promise<MarketTradability>;
```

Says whether a market can be traded now. The order book reports a market active that
cannot be traded: one that has expired, that is not set up on chain, or that the exchange
does not know. Orders on such a market can be accepted and then fail to settle. So this
checks that the order book takes orders, that the market has not ended, and three things
on chain: the condition is set up with two outcomes, it is not resolved, and the exchange
has registered the market.

It costs three reads of the chain, so [fetchMarket](#fetchmarket) does not do it. Use it to choose a
market, then trade. The verdict is a snapshot, not a guarantee. The end time is checked
against the clock of the machine running the SDK, corrected by XO's clock once the client
has read it (a secure client reads it when it is created).

`options` cover the two requests to XO (the market and its order book): their `timeout` and
`retries` apply to each of them. The three reads of the chain go through the chain reader,
which has its own timeouts and takes no call options, so `timeout` and `retries` do not
cover them. The `signal` is checked before the chain reads and again after them: aborting
while they run still rejects with a `RequestAbortedError` whose `cause` is the signal's
reason, and no verdict is returned. The chain reads themselves are not cut short.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchMarketTradabilityRequest`](../type-aliases/FetchMarketTradabilityRequest.md) | The market's `conditionId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the two requests to XO; only `signal` also applies to the chain reads, as described above. |

#### Returns

`Promise`\<[`MarketTradability`](../type-aliases/MarketTradability.md)\>

#### Throws

`invalid_input` for anything but a condition id,
  `invalid_request_options` for bad options; a `RequestAbortedError` when the signal is
  aborted; a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when XO has no
  such market, or the order book does not know it (code `not_tradable_on_orderbook`);
  `not_binary` when the order book's outcomes are not exactly YES and NO; a plain error with
  the code `chain_read_failed` when a read of the chain fails: the verdict is never guessed.

#### Example

```ts
const { ok, reasons } = await client.fetchMarketTradability({ conditionId });
if (!ok) {
  console.log('not tradable:', reasons.join(', '));
}
```

***

### fetchMidpoint()

```ts
fetchMidpoint(request, options?): Promise<string | null>;
```

Reads the midpoint of an outcome token: halfway between its best bid and its best ask, as
a decimal string between 0 and 1. It is `null` when a side of the book is empty: there is
no price to show. No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`AssetRequest`](../type-aliases/AssetRequest.md) | The token's `assetId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<`string` \| `null`\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when the
  order book has no book for the token.

#### Example

```ts
const midpoint = await client.fetchMidpoint({ assetId });
console.log(midpoint ?? 'no price');
```

***

### fetchMidpoints()

```ts
fetchMidpoints(request, options?): Promise<Record<string, string | null>>;
```

Reads the midpoints of several outcome tokens in one request, as an object by token id
(without leading zeros). Every token asked has an entry: its midpoint, or `null` when it has
none, because a side of its book is empty or the order book does not know it. No credentials
are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`AssetsRequest`](../type-aliases/AssetsRequest.md) | The tokens' `assetIds`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<`Record`\<`string`, `string` \| `null`\>\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and the read errors when the request fails.

#### Example

```ts
const midpoints = await client.fetchMidpoints({
  assetIds: [yesAssetId, noAssetId],
});
console.log(midpoints[yesAssetId] ?? 'no price');
```

***

### fetchOrderBook()

```ts
fetchOrderBook(request, options?): Promise<OrderBook>;
```

Reads the order book of an outcome token: the resting buy and sell orders, as a list of
price levels per side. Both sides are listed with the best price last, so the best bid is
`bids.at(-1)` and the best ask is `asks.at(-1)`. No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`AssetRequest`](../type-aliases/AssetRequest.md) | The token's `assetId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`OrderBook`](../type-aliases/OrderBook.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when the
  order book has no book for the token.

#### Example

```ts
const book = await client.fetchOrderBook({ assetId });
console.log(book.bids.at(-1), book.asks.at(-1));
```

***

### fetchOrderBooks()

```ts
fetchOrderBooks(request, options?): Promise<OrderBook[]>;
```

Reads the order books of several outcome tokens in one request, in the order asked. See
[fetchOrderBook](#fetchorderbook) for the order of the levels. No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`AssetsRequest`](../type-aliases/AssetsRequest.md) | The tokens' `assetIds`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`OrderBook`](../type-aliases/OrderBook.md)[]\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when the
  order book has no book for one of the tokens.

#### Example

```ts
const books = await client.fetchOrderBooks({
  assetIds: [yesAssetId, noAssetId],
});
console.log(books.map((book) => book.bids.at(-1)));
```

***

### fetchPrice()

```ts
fetchPrice(request, options?): Promise<string | null>;
```

Reads the best price on one side of an outcome token's book, as a decimal string between 0
and 1: the best bid for `BUY`, the best ask for `SELL`, or `null` when that side is empty.
No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchPriceRequest`](../type-aliases/FetchPriceRequest.md) | The token's `assetId` and the `side` to read. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<`string` \| `null`\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when the
  order book has no book for the token.

#### Example

```ts
const price = await client.fetchPrice({
  assetId,
  side: OrderSide.BUY,
});
console.log(price ?? 'nobody bids');
```

***

### fetchPrices()

```ts
fetchPrices(request, options?): Promise<Record<string, PricesBySide>>;
```

Reads the best prices of several outcome tokens and sides in one request, as an object by
token id (without leading zeros) and then by side. Every token and side asked has an entry:
the price, or `null` when that side of the book is empty or the order book does not know the
token. See [fetchPrice](#fetchprice) for what a side reads. No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchPricesRequest`](../type-aliases/FetchPricesRequest.md) | The `requests`: each a token's `assetId` and the `side` to read. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<`Record`\<`string`, [`PricesBySide`](../type-aliases/PricesBySide.md)\>\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and the read errors when the request fails.

#### Example

```ts
const prices = await client.fetchPrices({
  requests: [
    { assetId, side: OrderSide.BUY },
    { assetId, side: OrderSide.SELL },
  ],
});
console.log(prices[assetId]?.BUY);
```

***

### fetchPublicProfile()

```ts
fetchPublicProfile(request, options?): Promise<PublicProfile>;
```

Reads the public profile of a user: display name, picture, badges, social handles and
conviction points. A private profile leaves its bio, socials and badges `null`. No
credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`UsernameRequest`](../type-aliases/UsernameRequest.md) | The user's `username`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`PublicProfile`](../type-aliases/PublicProfile.md)\>

#### Throws

`invalid_input` for a request without a valid `username`,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when XO has
  no such user.

#### Example

```ts
const profile = await client.fetchPublicProfile({ username: 'xouser1330' });
console.log(profile.username, profile.tier, profile.badges);
```

***

### fetchPulseStats()

```ts
fetchPulseStats(options?): Promise<PulseStats>;
```

Reads the totals of the pulse markets that trade on the order book: volume, trades,
traders and open positions.

XO works the totals out when they are asked for, so while its cache warms up (it can take
about ten seconds) the service can answer 500. The SDK does not retry a 500, so the read
fails then: ask again after a moment.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`PulseStats`](../type-aliases/PulseStats.md)\>

#### Throws

`invalid_request_options` for bad options, and the read errors
  when the request fails, a 500 [RequestRejectedError](../classes/RequestRejectedError.md) while the service's cache warms
  up included.

#### Example

```ts
const stats = await client.fetchPulseStats();
console.log(stats.volume, stats.traderCount);
```

***

### fetchRewardGroup()

```ts
fetchRewardGroup(request, options?): Promise<RewardGroup>;
```

Reads one Pulse group in full: its programmes, the day in progress, the liquidity scored so
far and what it paid over its life.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchRewardGroupRequest`](../type-aliases/FetchRewardGroupRequest.md) | The group's `groupId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`RewardGroup`](../type-aliases/RewardGroup.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when XO
  has no such group.

#### Example

```ts
const group = await client.fetchRewardGroup({ groupId });
console.log(group.product?.name, group.lifetime);
```

***

### fetchSeries()

```ts
fetchSeries(request, options?): Promise<Series>;
```

Reads one series. Its events are listed by [listEvents](#listevents) with a `seriesId`, and its
markets by `listMarkets` with a `seriesId`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchSeriesRequest`](../type-aliases/FetchSeriesRequest.md) | Name the series by `id` or `slug`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`Series`](../type-aliases/Series.md)\>

#### Throws

`invalid_input` for a request that does not name exactly one
  series, `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when
  XO has no such series.

#### Example

```ts
const series = await client.fetchSeries({ slug: 'world-cup-2026' });
console.log(series.title, series.active);
```

***

### fetchSmartWalletAddress()

```ts
fetchSmartWalletAddress(request, options?): Promise<`0x${string}`>;
```

Reads the address of a smart wallet of `owner` from XO's smart wallet factory, on chain.
An owner has smart wallets 0, 1, 2… (`index`), and the address of each is fixed before it
is deployed, so this answers for one that does not exist yet. To trade from it, pass the
address as the `wallet` option of `createSecureClient`, with the owner's key as the
signer: it takes smart wallets 0 to 9, and deploys one that does not exist yet.

It is one read of the chain: no call to XO's API, and nothing is signed. `signal` and
`timeout` bound the read; the chain read retries on its own, so `retries` does not change
it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchSmartWalletAddressRequest`](../type-aliases/FetchSmartWalletAddressRequest.md) | The `owner`, a `0x` address, and the `index` of its smart wallet (0 when left out). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel and timeout of the read. |

#### Returns

`Promise`\<`` `0x${string}` ``\>

#### Throws

`invalid_input` for an owner that is not an address or
  an index that is not a whole number from 0, `invalid_request_options` for bad options, a
  `RequestAbortedError` or `TimeoutError` from the options, and an `XoError`
  `smart_wallet_address_unavailable` when the factory cannot be read.

#### Example

```ts
const wallet = await client.fetchSmartWalletAddress({ owner: await signer.getAddress() });
const secure = await createSecureClient({ signer, wallet });
console.log(secure.wallet === wallet);
```

***

### fetchSpread()

```ts
fetchSpread(request, options?): Promise<string | null>;
```

Reads the spread of an outcome token: the gap between its best ask and its best bid, as a
decimal string. It is `null` when a side of the book is empty, and `"0"` only when the best
bid meets the best ask. No credentials are sent.

The order book answers a spread of 0 for a book with an empty side too, so such an answer
costs a second request, which tells the two apart.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`AssetRequest`](../type-aliases/AssetRequest.md) | The token's `assetId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request, and of the second one. |

#### Returns

`Promise`\<`string` \| `null`\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when the
  order book has no book for the token.

#### Example

```ts
const spread = await client.fetchSpread({ assetId });
console.log(spread ?? 'no spread');
```

***

### fetchSpreads()

```ts
fetchSpreads(request, options?): Promise<Record<string, string | null>>;
```

Reads the spreads of several outcome tokens in one request, as an object by token id
(without leading zeros). Every token asked has an entry: its spread, or `null` when it has
none, because a side of its book is empty or the order book does not know it. No credentials
are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`AssetsRequest`](../type-aliases/AssetsRequest.md) | The tokens' `assetIds`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<`Record`\<`string`, `string` \| `null`\>\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and the read errors when the request fails.

#### Example

```ts
const spreads = await client.fetchSpreads({
  assetIds: [yesAssetId, noAssetId],
});
console.log(spreads[yesAssetId] ?? 'no spread');
```

***

### fetchTradingState()

```ts
fetchTradingState(options?): Promise<TradingState>;
```

Reads whether trading is `active` or `paused` on all of XO. While it is paused, a new order
is refused. A state added later is returned as it is. No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`TradingState`](../type-aliases/TradingState.md)\>

#### Throws

`invalid_request_options` for bad options, and the read
  errors when the request fails.

#### Example

```ts
const state = await client.fetchTradingState();
if (state === 'paused') {
  console.log('trading is paused');
}
```

***

### fetchUserRewards()

```ts
fetchUserRewards(request, options?): Promise<UserRewards>;
```

Reads what a wallet has earned from liquidity rewards: in each currency the total received,
what came from liquidity and what is accruing on the open day. A wallet that has earned
nothing reads zeros. Every figure is rounded to two decimals.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchUserRewardsRequest`](../type-aliases/FetchUserRewardsRequest.md) | The `user` wallet. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`UserRewards`](../type-aliases/UserRewards.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and the read errors when the request fails.

#### Example

```ts
const rewards = await client.fetchUserRewards({ user: wallet });
console.log(rewards.usdc?.totalReceived, rewards.cp?.totalReceived);
```

***

### fetchUserRewardsEpoch()

```ts
fetchUserRewardsEpoch(request, options?): Promise<UserRewardsEpoch>;
```

Reads one UTC day of a wallet's rewards across every market it made liquidity in: for each
market the score, the share of the pot and the payout.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchUserRewardsEpochRequest`](../type-aliases/FetchUserRewardsEpochRequest.md) | The `user` wallet and the `epoch`. See [FetchUserRewardsEpochRequest](../type-aliases/FetchUserRewardsEpochRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`UserRewardsEpoch`](../type-aliases/UserRewardsEpoch.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, and the read errors when the request fails.

#### Example

```ts
const day = await client.fetchUserRewardsEpoch({ user: wallet, epoch: 20_743 });
console.log(day.effectiveCp, day.markets.map((market) => market.conditionId));
```

***

### fetchUserStats()

```ts
fetchUserStats(request, options?): Promise<UserStats>;
```

Reads the trading statistics of any user by username: profit and loss, volume and the
number of markets traded. No credentials are sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`UsernameRequest`](../type-aliases/UsernameRequest.md) | The user's `username`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`UserStats`](../type-aliases/UserStats.md)\>

#### Throws

`invalid_input` for a request without a valid `username`,
  `invalid_request_options` for bad options, and a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when XO has
  no such user.

#### Example

```ts
const stats = await client.fetchUserStats({ username: 'xouser1330' });
console.log(stats.pnl, stats.volume, stats.tradedMarketCount);
```

***

### listBrowseItems()

```ts
listBrowseItems(request?, options?): Paginated<BrowseItem>;
```

Lists the cards of XO's market page: markets that stand alone, and events with their
markets, in the page's own trending order. [listMarkets](#listmarkets) cannot give this: it lists
markets one by one, without the events they sit under, and has no trending order.

Only CLOB markets with two outcomes are shown, and open (`active`) ones unless `status` says
otherwise. A card with none of those is left out. Reading the feed makes one request per page.

Nothing is requested until the feed is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListBrowseItemsRequest`](../type-aliases/ListBrowseItemsRequest.md) | The filters. See [ListBrowseItemsRequest](../type-aliases/ListBrowseItemsRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`BrowseItem`](../type-aliases/BrowseItem.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page of
  this feed, and the read errors when a page fails.

#### Example

```ts
const feed = client.listBrowseItems({ pageSize: 10 });
const page = await feed.firstPage();
for (const item of page.items) {
  console.log(item.kind === 'event' ? item.event.title : item.market.question);
}
```

***

### listCategories()

```ts
listCategories(options?): Paginated<Category>;
```

Lists the categories that markets are filed under, such as `Sports`, each with the number
of CLOB markets in it. All of them come on one page.

Nothing is requested until the list is read. A bad option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Category`](../type-aliases/Category.md)\>

#### Throws

`invalid_request_options` for bad options, `invalid_cursor` for
  any cursor (the list has one page), and the read errors when the request fails.

#### Example

```ts
const page = await client.listCategories().firstPage();
for (const category of page.items) {
  console.log(category.name, category.marketCount);
}
```

***

### listEvents()

```ts
listEvents(request?, options?): Paginated<Event>;
```

Lists events, a page at a time: the events that are not sub-events of another. Reading the
list makes one request per page.

An event in a list has no markets (`markets` is `null`) unless `withMarkets` asks for them.
[fetchEvent](#fetchevent) loads them for one event.

Nothing is requested until the list is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListEventsRequest`](../type-aliases/ListEventsRequest.md) | The filters. See [ListEventsRequest](../type-aliases/ListEventsRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Event`](../type-aliases/Event.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page of
  this list, and the read errors when a page fails.

#### Example

```ts
const events = client.listEvents({ pageSize: 20 });
const page = await events.firstPage();
for (const event of page.items) {
  console.log(event.title, event.slug);
}
```

***

### listMarketRewardsMakers()

```ts
listMarketRewardsMakers(request, options?): Paginated<RewardsMaker>;
```

Lists the makers who scored on one UTC day of a market, a page at a time, with each maker's
score, share of the pot and payout. The list is the conviction-points programme's. A market
with no rewards programme has no makers: its list is empty.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ListMarketRewardsMakersRequest`](../type-aliases/ListMarketRewardsMakersRequest.md) | The market, the day and the page size. See [ListMarketRewardsMakersRequest](../type-aliases/ListMarketRewardsMakersRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`RewardsMaker`](../type-aliases/RewardsMaker.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
  of this list, and the read errors when a page fails.

#### Example

```ts
const makers = client.listMarketRewardsMakers({ conditionId, pageSize: 100 });
for await (const page of makers) {
  console.log(page.items.map((maker) => `${maker.wallet} ${maker.effective}`));
}
```

***

### listMarketRewardsOrders()

```ts
listMarketRewardsOrders(request, options?): Paginated<RewardsOrder>;
```

Lists the orders that scored on one UTC day of a market, a page at a time, each with its
maker, price, score and payout. A market with no rewards programme has none: its list is
empty.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ListMarketRewardsOrdersRequest`](../type-aliases/ListMarketRewardsOrdersRequest.md) | The market, the day, the maker to filter by and the page size. See [ListMarketRewardsOrdersRequest](../type-aliases/ListMarketRewardsOrdersRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`RewardsOrder`](../type-aliases/RewardsOrder.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
  of this list, and the read errors when a page fails.

#### Example

```ts
const orders = client.listMarketRewardsOrders({ conditionId, maker: wallet });
const page = await orders.firstPage();
console.log(page.items.map((order) => `${order.side} ${order.price} scored ${order.score}`));
```

***

### listMarkets()

```ts
listMarkets(request?, options?): Paginated<Market>;
```

Lists CLOB markets with two outcomes, a page at a time. Without `status` it lists open
(`active`) markets only; pass `status: 'closed'` or `'resolved'` for the others.

Reading the list makes one request per page. A market in a list has only what the list
carries: the fields that need the order book, the fee policy or the rewards programme are
`null` (see [fetchMarket](#fetchmarket), which fills them). Rows that are not CLOB markets with two
outcomes are left out, so a page can hold fewer markets than `pageSize`.

With `eventId` or `seriesId` the markets of that event or series are listed, each with its
label in `groupItemTitle`.

Nothing is requested until the list is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListMarketsRequest`](../type-aliases/ListMarketsRequest.md) | The filters. See [ListMarketsRequest](../type-aliases/ListMarketsRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Market`](../type-aliases/Market.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page of
  this list, and the read errors when a page fails.

#### Example

```ts
const markets = client.listMarkets({ status: 'active', sort: 'volume', pageSize: 20 });
const first = await markets.firstPage();
for (const market of first.items) {
  console.log(market.question, market.outcomes.yes.tokenId);
}
const second = await markets.from(first.nextCursor).firstPage();
```

***

### listPositions()

```ts
listPositions(request, options?): Paginated<Position>;
```

Lists the positions of a wallet, a page at a time: what it holds in each outcome of each
market, with the value and the profit or loss, and whether it can be redeemed. Anyone can
read them by the wallet's address; no credentials are sent. A private profile lists none.
Each page holds the positions of up to 1000 markets.

`redeemable: true` lists only the positions the SDK can redeem now: their market is
resolved or voided, the winnings are not claimed, and the market is one of the order book.
A settled position of an older market type pays out on that market's own contract: it is
listed with `status: 'REDEEMABLE'` and `redeemable: false`. `market` lists the positions of
one market. Both are kept here from the pages XO sends, so a page can hold fewer positions
than XO sent, even none, and still have more after it.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ListPositionsRequest`](../type-aliases/ListPositionsRequest.md) | The `user` wallet, and the filters. See [ListPositionsRequest](../type-aliases/ListPositionsRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Position`](../type-aliases/Position.md)\>

#### Throws

`invalid_input` for a request that is not valid (one without
  `user` included), `invalid_request_options` for bad options, `invalid_cursor` for a cursor
  that is not a page of this list, a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when XO has no such
  user, and the read errors when a page fails.

#### Example

```ts
const page = await client.listPositions({ user: wallet }).firstPage();
for (const position of page.items) {
  console.log(position.title, position.outcome, position.currentSize, position.currentValue);
}
```

***

### listPriceHistory()

```ts
listPriceHistory(request, options?): Paginated<PricePoint>;
```

Lists the recent trade prices of an outcome token, oldest first, on one page.

The order book answers with its newest trades only: `fidelity` of them (100 by default, at
most 500). `interval`, `startTs` and `endTs` then keep the points inside the window, so a
window that reaches back further than those trades is cut at the oldest one. The page never
has more. A token the order book has no trades for gives an empty page.

Nothing is requested until the list is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ListPriceHistoryRequest`](../type-aliases/ListPriceHistoryRequest.md) | The token, the window and how many points to read. See [ListPriceHistoryRequest](../type-aliases/ListPriceHistoryRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`PricePoint`](../type-aliases/PricePoint.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for any cursor (the list has
  one page), and the read errors when the request fails.

#### Example

```ts
const page = await client.listPriceHistory({
  assetId,
  interval: '1d',
}).firstPage();
for (const point of page.items) {
  console.log(new Date(point.timestamp).toISOString(), point.price);
}
```

***

### listPulseMarkets()

```ts
listPulseMarkets(request?, options?): Paginated<PulseMarket>;
```

Lists the rounds of the pulse markets, newest first, a page at a time. Only the rounds that
trade on the order book are listed, so a page can hold fewer rounds than `pageSize`, even
none, and still have more pages. A round's `conditionId` is the key to trade it with
`fetchMarket`.

Nothing is requested until the list is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListPulseMarketsRequest`](../type-aliases/ListPulseMarketsRequest.md) | The filters. See [ListPulseMarketsRequest](../type-aliases/ListPulseMarketsRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`PulseMarket`](../type-aliases/PulseMarket.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page of
  this list, and the read errors when a page fails.

#### Example

```ts
const page = await client.listPulseMarkets({ status: 'active' }).firstPage();
for (const round of page.items) {
  console.log(round.name, round.endDate, round.conditionId);
}
```

***

### listRewardGroups()

```ts
listRewardGroups(request?, options?): Paginated<RewardGroup>;
```

Lists the Pulse groups, a page at a time. A group is one shared reward pool for all the short
rounds of a product, such as one pot for every five-minute window of a price market. A group
in a list has only what the list carries: `day`, `totalScoredLiquidity` and `lifetime` are
`null` (see [fetchRewardGroup](#fetchrewardgroup), which fills them).

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListRewardGroupsRequest`](../type-aliases/ListRewardGroupsRequest.md) | The filters. See [ListRewardGroupsRequest](../type-aliases/ListRewardGroupsRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`RewardGroup`](../type-aliases/RewardGroup.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
  of this list, and the read errors when a page fails.

#### Example

```ts
const groups = client.listRewardGroups({ currency: 'USDC', pageSize: 20 });
for await (const page of groups) {
  console.log(page.items.map((group) => group.product?.name));
}
```

***

### listRewardPools()

```ts
listRewardPools(options?): Paginated<RewardPool>;
```

Lists the markets that pay liquidity rewards, each with its programme per currency: how much
is paid a day, the terms for scoring orders, the budget and the bonus windows. All of them
come on one page, with the biggest daily pool first.

Nothing is requested until the list is read. A bad option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`RewardPool`](../type-aliases/RewardPool.md)\>

#### Throws

`invalid_request_options` for bad options, `invalid_cursor`
  for any cursor (the list has one page), and the read errors when the request fails.

#### Example

```ts
const page = await client.listRewardPools().firstPage();
for (const pool of page.items) {
  console.log(pool.market?.title, pool.programmes.map((p) => `${p.dailyPool} ${p.currency}`));
}
```

***

### listSeries()

```ts
listSeries(request?, options?): Paginated<Series>;
```

Lists series of events, such as tournaments. The running ones, unless `active` is `false`.
All of them come on one page.

Nothing is requested until the list is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListSeriesRequest`](../type-aliases/ListSeriesRequest.md) | The filter. See [ListSeriesRequest](../type-aliases/ListSeriesRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Series`](../type-aliases/Series.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for any cursor (the list has one
  page), and the read errors when the request fails.

#### Example

```ts
const page = await client.listSeries().firstPage();
console.log(page.items.map((series) => series.title));
```

***

### listSubcategories()

```ts
listSubcategories(request?, options?): Paginated<Subcategory>;
```

Lists the subcategories under the categories, such as `Football` under `Sports`, each with
the number of CLOB markets in it. All of them come on one page.

Nothing is requested until the list is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListSubcategoriesRequest`](../type-aliases/ListSubcategoriesRequest.md) | The filter. See [ListSubcategoriesRequest](../type-aliases/ListSubcategoriesRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Subcategory`](../type-aliases/Subcategory.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for any cursor (the list has one
  page), and the read errors when the request fails.

#### Example

```ts
const page = await client.listSubcategories({ categoryId: '1' }).firstPage();
console.log(page.items.map((subcategory) => subcategory.name));
```

***

### listSubevents()

```ts
listSubevents(request, options?): Paginated<Event>;
```

Lists the sub-events of an event, for example the first half of a match. Each is an event
of its own, with `parentEventId` set and its markets not loaded: [fetchEvent](#fetchevent) loads
them. All of them come on one page.

Nothing is requested until the list is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ListSubeventsRequest`](../type-aliases/ListSubeventsRequest.md) | The event. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Event`](../type-aliases/Event.md)\>

#### Throws

`invalid_input` for a request without a valid `eventId`,
  `invalid_request_options` for bad options, `invalid_cursor` for any cursor (the list has one
  page), a 404 [RequestRejectedError](../classes/RequestRejectedError.md) when XO has no such event, and the other read errors.

#### Example

```ts
const page = await client.listSubevents({ eventId }).firstPage();
console.log(page.items.map((event) => event.title));
```

***

### listTrades()

```ts
listTrades(request, options?): Paginated<MarketTrade>;
```

Lists the fills of one CLOB market, newest first, a page at a time: who bought or sold how
many shares at what price. Anyone can read them; no credentials are sent. A market id is
required: the fills of all markets together are not offered. The market's own fields
(`conditionId`, `title`, `slug`, `icon`) are left out of the rows, which you know already.

Only fills are listed. A creator's share unlock, which XO's trade feed also carries, is not
a fill and is left out, so a page can hold fewer fills than `pageSize`.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ListTradesRequest`](../type-aliases/ListTradesRequest.md) | The market (`marketId`) and the filters. See [ListTradesRequest](../type-aliases/ListTradesRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`MarketTrade`](../type-aliases/MarketTrade.md)\>

#### Throws

`invalid_input` for a request that is not valid, a missing
  `marketId` included, `invalid_request_options` for bad options, `invalid_cursor` for a
  cursor that is not a page of this list, a 404 [RequestRejectedError](../classes/RequestRejectedError.md) for a
  `marketId` XO does not know, and the read errors when a page fails.

#### Example

```ts
const page = await client.listTrades({ marketId: market.id, pageSize: 20 }).firstPage();
for (const trade of page.items) {
  console.log(trade.side, trade.size, 'at', trade.price);
}
```

***

### listUserRewardsOrders()

```ts
listUserRewardsOrders(request, options?): Paginated<RewardsOrder>;
```

Lists the orders of a wallet that were scored for rewards, a page at a time, each with its
market, price, score, how it ended and what it paid per currency.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ListUserRewardsOrdersRequest`](../type-aliases/ListUserRewardsOrdersRequest.md) | The wallet and the filters. See [ListUserRewardsOrdersRequest](../type-aliases/ListUserRewardsOrdersRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`RewardsOrder`](../type-aliases/RewardsOrder.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
  of this list, and the read errors when a page fails.

#### Example

```ts
const orders = client.listUserRewardsOrders({ user: wallet, epoch: 20_743 });
for await (const page of orders) {
  console.log(page.items.map((order) => order.payouts));
}
```

***

### subscribe()

```ts
subscribe<S>(specs): Promise<SubscriptionHandle<EventOf<S[number]>>>;
```

Streams live events of one or more topics through one handle. Each spec names a topic:

- `market`: the order books, price changes and fills of outcome tokens (`assetIds`, the
  `assetId` of an order book) or of whole markets (`markets`, by condition id). A `book`
  event comes for each token when the subscription opens and after each reconnect.
- `activity`: the newest fills of one market, by XO's id for it (`marketId`, the `id` of a
  `Market`), each time it trades.

The account's topics, `user` (its orders and trades) and `portfolio` (its positions), need a
client signed in with a wallet, from `createSecureClient`. The specs of the `market` topic
share one connection, split over several above 100 ids.

The handle's loop yields the events of every topic, in the order they arrive, narrowed to
the topics asked for: switch on `event.topic` or `event.type`. A stream reconnects by itself
but does not replay what it missed. The handle's `'reconnected'` (`{ topic }`) and its
errors (`error.topic`) name the topic they concern: on `'reconnected'` and on
`ws_events_dropped`, re-read the state of the topic named (`fetchOrderBooks` for `market`;
the next `activity` event is whole again). `subscription_overflow` names no topic: re-read
every one. Close the handle when you are done; [closeSubscriptions](#closesubscriptions) closes every
handle of the client.

#### Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* readonly [`PublicSubscriptionSpec`](../type-aliases/PublicSubscriptionSpec.md)[] |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `specs` | `S` & [`ExactSpecs`](../type-aliases/ExactSpecs.md)\<`S`\> | The topics, such as `[{ topic: 'market', assetIds }]`. See [SubscriptionSpec](../type-aliases/SubscriptionSpec.md). |

#### Returns

`Promise`\<[`SubscriptionHandle`](SubscriptionHandle.md)\<[`EventOf`](../type-aliases/EventOf.md)\<`S`\[`number`\]\>\>\>

#### Throws

`invalid_input` for specs that are not valid (an empty list, an
  unknown topic or key, a `market` spec with no id, an id that is not one);
  `topic_needs_sign_in` for the `user` or `portfolio` topic; and `invalid_input` for the
  `market` topic when the runtime has no `WebSocket` and none was passed to
  [createPublicClient](../functions/createPublicClient.md). Nothing is opened then.

#### Example

```ts
const handle = await client.subscribe([{ topic: 'market', assetIds: [assetId] }]);
try {
  for await (const event of handle) {
    if (event.type === 'book') {
      console.log(event.assetId, event.bids.at(-1), event.asks.at(-1));
    }
  }
} finally {
  await handle.close();
}
```
