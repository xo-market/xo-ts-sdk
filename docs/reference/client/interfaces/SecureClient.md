# Interface: SecureClient

A client that has signed in with a wallet. It reads everything a [PublicClient](PublicClient.md)
reads, and holds the wallet's credentials: an API key for XO's account data and order book
credentials for trading. Create it with [createSecureClient](../functions/createSecureClient.md).

When the process is done with it, call [SecureClient.close](#close). To sign the wallet out
for good, call [SecureClient.endAuthentication](#endauthentication). After either one, every member
throws a `UserInputError` with the code `client_closed`.

## Example

```ts
const client = await createSecureClient({ signer: privateKey(process.env.XO_PK as string) });
console.log(client.wallet);
console.log(await client.fetchMidpoint({ assetId }));
```

## Extends

- [`PublicClient`](PublicClient.md)

## Properties

### wallet

```ts
readonly wallet: `0x${string}`;
```

The address of the account that trades and holds the funds: the signer's own address, or
the smart wallet that the `wallet` option named. Checksummed.

#### Example

```ts
const client = await createSecureClient({ signer });
console.log(`trading from ${client.wallet}`);
```

## Methods

### cancelAll()

```ts
cancelAll(): Promise<CancelOrdersResponse>;
```

Cancels every open order of the account, in every market, including the orders that wait
out the taker delay. An order that already filled is not undone.

The cancel is sent once and never retried. When its answer is lost, it throws with
`mayHaveLanded: true`: read your open orders with [listOpenOrders](#listopenorders) first. If you send
it again yourself, it also cancels an order placed between the two, and the orders the
first one cancelled are missing from `canceled`.

#### Returns

`Promise`\<[`CancelOrdersResponse`](../type-aliases/CancelOrdersResponse.md)\>

#### Throws

`client_closed` after [close](#close) or [endAuthentication](#endauthentication),
  and the request errors, which say `mayHaveLanded: true` when the cancel may have gone
  through and `false` when XO refused it or it was not sent.

#### Example

```ts
const result = await client.cancelAll();
console.log(`cancelled ${result.canceled.length} orders`);
```

***

### cancelMarketOrders()

```ts
cancelMarketOrders(request): Promise<CancelOrdersResponse>;
```

Cancels the open orders of the account in one market, or of one outcome. With `market`
alone, XO cancels every order of that market, both outcomes and the orders that wait out
the taker delay, in one request. With an `assetId`, the client lists that outcome's orders
that rest on the book (in that `market`, when given) and cancels them by id: an order placed
meanwhile, or one still waiting out the taker delay, is not cancelled.

Each cancel request is sent once and never retried. When its answer is lost, it throws with
`mayHaveLanded: true`: read your open orders with [listOpenOrders](#listopenorders) first. By id, 300
to a request, a request after the first that fails, however it fails, says
`mayHaveLanded: true` too: the requests before it cancelled orders. If you send it again
yourself with `market` alone, it also cancels an order placed between the two, and the
orders the first one cancelled are missing from `canceled`; by id, they come back in
`notCanceled`, not found.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`CancelMarketOrdersRequest`](../type-aliases/CancelMarketOrdersRequest.md) | The `market` (a condition id), the `assetId` of an outcome, or both. |

#### Returns

`Promise`\<[`CancelOrdersResponse`](../type-aliases/CancelOrdersResponse.md)\>

#### Throws

`invalid_input` without a market and an outcome, or for an
  id that is not valid; `client_closed` after [close](#close) or [endAuthentication](#endauthentication);
  and the request errors, which say `mayHaveLanded: true` when a cancel may have gone through
  and `false` only when nothing was cancelled (XO refused the first request, it was not
  sent, or reading the outcome's orders failed). After a cancel that partly failed, read
  your open orders with [listOpenOrders](#listopenorders) before acting.

#### Example

```ts
const result = await client.cancelMarketOrders({ market: conditionId });
console.log(result.canceled);
```

***

### cancelOrder()

```ts
cancelOrder(request): Promise<CancelOrdersResponse>;
```

Cancels one open order of the account, resting on the book or waiting out the taker delay.
The answer lists it in `canceled`, or in `notCanceled` with XO's reason: an order that is
not open (it filled, was cancelled, or never reached XO: [reconcileOrder](#reconcileorder) tells
which) is not cancelled because it is not found.

The cancel is sent once and never retried. When its answer is lost (a timeout, a lost
connection, a 5xx), it throws with `mayHaveLanded: true`: the order may be cancelled, so
read it with [fetchOrder](#fetchorder) first. If you send the cancel again yourself, an order the
first one cancelled comes back in `notCanceled`, not found.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`CancelOrderRequest`](../type-aliases/CancelOrderRequest.md) | The order's `orderId`: its hash, as a placement gives it, or a numeric order id. |

#### Returns

`Promise`\<[`CancelOrdersResponse`](../type-aliases/CancelOrdersResponse.md)\>

#### Throws

`invalid_input` for an id that is neither, `client_closed` after
  [close](#close) or [endAuthentication](#endauthentication), and the request errors, which say
  `mayHaveLanded: true` when the cancel may have gone through and `false` when XO refused it
  or it was not sent.

#### Example

```ts
const result = await client.cancelOrder({ orderId });
console.log(result.canceled, result.notCanceled);
```

***

### cancelOrders()

```ts
cancelOrders(request): Promise<CancelOrdersResponse>;
```

Cancels open orders of the account by id, 300 to a request. The answer lists each order in
`canceled`, or in `notCanceled` with XO's reason, such as `order not found` for one that is
not open. Ids are given back in canonical form: hashes in lower case, numeric ids without
leading zeros.

Each request is sent once and never retried. When the answer of one is lost, it throws with
`mayHaveLanded: true`: its orders may be cancelled, so read your open orders with
[listOpenOrders](#listopenorders) first. When a request after the first fails, however it fails, the
error says `mayHaveLanded: true` too: the requests before it cancelled orders. If you send a
cancel again yourself, an order an earlier one cancelled comes back in `notCanceled`, not
found.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`CancelOrdersRequest`](../type-aliases/CancelOrdersRequest.md) | The `orderIds`: order hashes or numeric order ids, at least one. |

#### Returns

`Promise`\<[`CancelOrdersResponse`](../type-aliases/CancelOrdersResponse.md)\>

#### Throws

`invalid_input` for an empty list or an id that is not one,
  `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the request errors,
  which say `mayHaveLanded: true` when a cancel may have gone through and `false` only when
  nothing was cancelled (XO refused the first request, or it was not sent). After a cancel
  that partly failed, read your open orders with [listOpenOrders](#listopenorders) before acting.

#### Example

```ts
const result = await client.cancelOrders({ orderIds: [firstId, secondId] });
console.log(result.canceled.length);
```

***

### close()

```ts
close(): Promise<void>;
```

Ends the client for this process: it places no new order from the moment it is called,
stops its order heartbeat, closes its subscriptions and, when the client signed in for a
1-day API key (no persistent `store`), revokes that key. A key from a persistent store
stays for the next run, and credentials given in `credentials` stay active. The order
book credentials are kept.

Afterwards every member throws a `UserInputError` with the code `client_closed`. Calling
it again returns the same promise. It never rejects: a revoke that fails is reported in a
warning, and the key then expires within a day.

#### Returns

`Promise`\<`void`\>

#### Example

```ts
const client = await createSecureClient({ signer });
await client.close();
```

***

### closeSubscriptions()

```ts
closeSubscriptions(): Promise<void>;
```

Closes every live subscription this client opened with [subscribe](PublicClient.md#subscribe), and returns once
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`closeSubscriptions`](PublicClient.md#closesubscriptions)

***

### createDeposit()

```ts
createDeposit(request): Promise<BridgePayment>;
```

Confirms a deposit quote, once: the payment it gives says where to send the funds
(`deposit`: a one-time address, the exact amount and the token). Sending them is up to you;
then follow the payment with [waitForBridgePayment](#waitforbridgepayment). The bridge answers a repeated
confirm with the payment it has. A payment in `CONFIRM_UNKNOWN` has no `deposit` yet: read it
again with [fetchBridgePayment](#fetchbridgepayment) before you send anything.

When the bridge asks the owner wallet to sign first, every item is checked and shown to your
`verify` callback, and nothing is signed unless it approves them all. Without it, the call
fails with `verification_required` and the payment waits: finish it with
[verifyBridgePayment](#verifybridgepayment).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`CreateDepositRequest`](../type-aliases/CreateDepositRequest.md) | The `quote`, and `verify` when the bridge may ask for signatures. |

#### Returns

`Promise`\<[`BridgePayment`](../type-aliases/BridgePayment.md)\>

#### Throws

`invalid_input` for a request that is not valid (a withdrawal
  quote included; nothing is sent), `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), a 409 `RequestRejectedError` `quote_expired`,
  `verification_required`, the signer's errors, and, with `mayHaveLanded: true` and the
  `paymentId`, a confirm whose answer was lost: read the payment before anything else.

#### Example

```ts
const [quote] = await client.quoteDeposit({ assetId, amount: '25' });
const payment = await client.createDeposit({ quote });
console.log(payment.deposit?.address, payment.deposit?.amount);
```

***

### createLimitOrder()

```ts
createLimitOrder(request): Promise<SignedOrder>;
```

Builds and signs a limit order without sending it: the wallet signs, and nothing goes to
XO. Send it with [postOrder](#postorder), or several at once with [postOrders](#postorders). The order
is good till cancelled; an `expiration` makes it good till that time. Building it reads the
market's tick size and the account's exchange nonce. Nothing is rounded: a price off the
market's tick size is refused. The signed order is frozen, since changing it would break
its signature.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`CreateLimitOrderRequest`](../type-aliases/CreateLimitOrderRequest.md) | The outcome token (`assetId`), the `side`, the `price` and the `size`, and `postOnly` and `expiration` when wanted. See [CreateLimitOrderRequest](../type-aliases/CreateLimitOrderRequest.md). |

#### Returns

`Promise`\<[`SignedOrder`](SignedOrder.md)\>

#### Throws

`invalid_input` for a request that is not valid (a price
  off the market's tick size, fewer than 1 share, more than 6 decimals, an expiration in
  milliseconds or too soon), `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), a `SigningError` when the wallet does not sign, and the errors
  of reading the tick size or the exchange nonce (`nonce_unavailable`).

#### Example

```ts
const order = await client.createLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: '0.52',
  size: 10,
});
console.log(order.orderHash);
```

***

### createMarketOrder()

```ts
createMarketOrder(request): Promise<SignedOrder>;
```

Builds and signs a market order without sending it. A buy spends an `amount` of dollars
and a sell gives a number of `shares`, at the best prices on the book: the order is a limit
order at the worst price you accept. That is `maxPrice` for a buy and `minPrice` for a
sell; without them it is 0.999 to buy and 0.001 to sell, so the order takes whatever the
book offers. It is fill-and-kill (the part that does not fill at once is dropped) unless
`orderType` is `OrderType.FOK` (all of it fills at once, or none). Send it with
[postOrder](#postorder).

A buy must be worth at least one share at its worst price: 0.999 dollars without
`maxPrice`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`CreateMarketOrderRequest`](../type-aliases/CreateMarketOrderRequest.md) | The outcome token (`assetId`), the `side`, the `amount` of a buy or the `shares` of a sell, and `maxPrice` or `minPrice` when wanted. See [CreateMarketOrderRequest](../type-aliases/CreateMarketOrderRequest.md). |

#### Returns

`Promise`\<[`SignedOrder`](SignedOrder.md)\>

#### Throws

`invalid_input` for a request that is not valid (`shares`
  on a buy, `amount` on a sell, `minPrice` on a buy, `maxPrice` on a sell, a worst price off
  the market's tick size, an amount below one share's worth), `client_closed` after
  [close](#close) or [endAuthentication](#endauthentication), a `SigningError` when the wallet does not
  sign, and the errors of reading the tick size (only with a worst price) or the exchange
  nonce (`nonce_unavailable`).

#### Example

```ts
const order = await client.createMarketOrder({
  assetId,
  side: OrderSide.BUY,
  amount: 10,
  maxPrice: '0.6',
});
console.log(order.orderType);
```

***

### endAuthentication()

```ts
endAuthentication(): Promise<PublicClient>;
```

Signs the wallet out, for good, and returns a client that reads public data. It revokes
the wallet's API key whether the client signed in for it, loaded it from the `store` or
was given it in `credentials`; deletes it from the store; and deletes the wallet's order
book API key. That key is shared by every process that trades for the same wallet: all of
them lose it, and each one signs in again for a new key when it next needs one.

From the moment it is called the client places no new order, stops its order heartbeat and
closes its subscriptions; afterwards every member throws a `UserInputError` with the code
`client_closed`, whether the sign-out worked or not. Every step is tried even when one
fails. A key that could not be revoked stays in the store, so a new client for the same
wallet can sign out again. Calling it again returns the same promise.

To end only this process and keep a stored key for the next run, call [close](#close)
instead.

#### Returns

`Promise`\<[`PublicClient`](PublicClient.md)\>

A client that reads public data, on the same environment and with the same
  `fetch`, `WebSocket` and `onRateLimitUpdate`.

#### Throws

`client_closed` when [close](#close) was called first (nothing
  is revoked then); `api_key_not_listed` for an API key given in `credentials` that the
  account's key listing does not show, so it could not be revoked; and the request errors
  of a revoke or deletion that failed (the client is closed anyway).

#### Example

```ts
const publicClient = await client.endAuthentication();
console.log(await publicClient.fetchTradingState());
```

***

### exportCredentials()

```ts
exportCredentials(): Promise<Required<WalletCredentials>>;
```

The credentials the client uses: its API key, with its `id` and `expiresAt` when they are
known, and its order book credentials. They are secrets: keep them out of logs. Pass them
as they are as the `credentials` of another client for the same wallet, to use them there
without signing in again. A key the client was given without its `id` and `expiresAt` comes
back without them.

With the default memory store the API key lasts a day and [close](#close) revokes it; use a
persistent `store` to keep one across runs.

#### Returns

`Promise`\<`Required`\<[`WalletCredentials`](WalletCredentials.md)\>\>

#### Throws

`client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the errors of signing in again when the API key was due
  for rotation.

#### Example

```ts
const credentials = await client.exportCredentials();
const again = await createSecureClient({ signer, credentials });
console.log(credentials.backend.expiresAt, again.wallet);
```

***

### fetchAccountTrade()

```ts
fetchAccountTrade(request, options?): Promise<Trade>;
```

Reads one trade of the account, to follow its settlement on chain: its `status` goes from
`MATCHED` to `MINED` and `CONFIRMED` (or `FAILED`), and `transactionHash` is set once the
settlement is sent.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchAccountTradeRequest`](../type-aliases/FetchAccountTradeRequest.md) | The trade's `tradeId`, `0x` and 64 hex digits. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`Trade`](../type-aliases/Trade.md)\>

#### Throws

`invalid_input` for an id that is not one,
  `invalid_request_options` for bad options, a 404 `RequestRejectedError` when XO does not
  know the trade, `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the
  read errors.

#### Example

```ts
const trade = await client.fetchAccountTrade({ tradeId });
console.log(trade.status, trade.transactionHash);
```

***

### fetchBalances()

```ts
fetchBalances(options?): Promise<Balances>;
```

Reads what the order book holds for the account now: its cash credit (`collateral`), and
for each outcome token the shares it holds and those that resting sell orders reserve. This
is what trading can use, not the balances at the wallet address on chain: the two can
differ, for example right after a deposit or before a withdrawal.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`Balances`](../type-aliases/Balances.md)\>

#### Throws

`invalid_request_options` for bad options, `client_closed` after
  [close](#close) or [endAuthentication](#endauthentication), an `UnexpectedResponseError` for an amount that
  cannot be read, and the read errors.

#### Example

```ts
const balances = await client.fetchBalances();
console.log(balances.collateral, balances.positions.map((p) => `${p.assetId}: ${p.balance}`));
```

***

### fetchBridgePayment()

```ts
fetchBridgePayment(request, options?): Promise<BridgePayment>;
```

Reads one payment by its id: a deposit or a withdrawal at any point of its life, or a quote
nobody confirmed. Its `status` says what to do next.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`BridgePaymentRequest`](../type-aliases/BridgePaymentRequest.md) | The `paymentId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`BridgePayment`](../type-aliases/BridgePayment.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), a 404 `RequestRejectedError` `payment_not_found`, and the read
  errors.

#### Example

```ts
const payment = await client.fetchBridgePayment({ paymentId });
console.log(payment.status, payment.fundingClaimedAt);
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchCollateralTokens`](PublicClient.md#fetchcollateraltokens)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchConvictionMarket`](PublicClient.md#fetchconvictionmarket)

***

### fetchEvent()

```ts
fetchEvent(request, options?): Promise<Event>;
```

Reads one event with its markets: the CLOB markets with two outcomes that are placed on it
and on its sub-events, each with its label in `groupItemTitle`. The sub-events themselves are
listed by [listSubevents](PublicClient.md#listsubevents).

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchEvent`](PublicClient.md#fetchevent)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchLastTradePrice`](PublicClient.md#fetchlasttradeprice)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchLastTradePrices`](PublicClient.md#fetchlasttradeprices)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchMarket`](PublicClient.md#fetchmarket)

***

### fetchMarketCapacity()

```ts
fetchMarketCapacity(request, options?): Promise<MarketCapacity>;
```

Reads what the account can still commit in one market: the USDC a new buy may use, and for
each outcome the shares a new sell may use, once its open orders are counted. Use it to
size an order.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ConditionRequest`](../type-aliases/ConditionRequest.md) | The market's `conditionId`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`MarketCapacity`](../type-aliases/MarketCapacity.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const capacity = await client.fetchMarketCapacity({ conditionId });
console.log(capacity.buyCapacity, capacity.positions.map((position) => position.free));
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchMarketRewards`](PublicClient.md#fetchmarketrewards)

***

### fetchMarketRewardsEpoch()

```ts
fetchMarketRewardsEpoch(request, options?): Promise<MarketRewardsEpoch>;
```

Reads one UTC day of a market's rewards: for each currency the pot, the total score, how many
makers scored, what was allocated and paid, and the makers with the highest scores.

A market with no rewards programme is not an error: it reads as an empty day, with a rail per
currency, no pot (`pool` is `null`) and no makers. Use [fetchMarketRewards](PublicClient.md#fetchmarketrewards) to tell
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchMarketRewardsEpoch`](PublicClient.md#fetchmarketrewardsepoch)

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

It costs three reads of the chain, so [fetchMarket](PublicClient.md#fetchmarket) does not do it. Use it to choose a
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchMarketTradability`](PublicClient.md#fetchmarkettradability)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchMidpoint`](PublicClient.md#fetchmidpoint)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchMidpoints`](PublicClient.md#fetchmidpoints)

***

### fetchOrder()

```ts
fetchOrder(request, options?): Promise<OpenOrder>;
```

Reads one open order of the account: resting on the book, or (by its hash) waiting out the
taker delay, which reads as `LIVE`. An order that filled or was cancelled is not open: to
find out what became of a placed order, use [reconcileOrder](#reconcileorder).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchOrderRequest`](../type-aliases/FetchOrderRequest.md) | The order's `orderId`: its hash, or a numeric order id. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`OpenOrder`](../type-aliases/OpenOrder.md)\>

#### Throws

`invalid_input` for an id that is not one, `invalid_request_options`
  for bad options, a 404 `RequestRejectedError` when the order is not open or not the
  account's, `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the read
  errors.

#### Example

```ts
const order = await client.fetchOrder({ orderId });
console.log(order.status, order.sizeMatched);
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchOrderBook`](PublicClient.md#fetchorderbook)

***

### fetchOrderBooks()

```ts
fetchOrderBooks(request, options?): Promise<OrderBook[]>;
```

Reads the order books of several outcome tokens in one request, in the order asked. See
[fetchOrderBook](PublicClient.md#fetchorderbook) for the order of the levels. No credentials are sent.

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchOrderBooks`](PublicClient.md#fetchorderbooks)

***

### fetchPortfolioValue()

```ts
fetchPortfolioValue(options?): Promise<PortfolioValue>;
```

Reads the account's cash and portfolio figures, in dollars: the spendable USDC, what the
open positions are worth, the winnings not yet redeemed, and their sum. Every market type is
counted.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`PortfolioValue`](../type-aliases/PortfolioValue.md)\>

#### Throws

`invalid_request_options` for bad options,
  `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const value = await client.fetchPortfolioValue();
console.log(value.value, value.cash, value.claimableAmount);
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchPrice`](PublicClient.md#fetchprice)

***

### fetchPrices()

```ts
fetchPrices(request, options?): Promise<Record<string, PricesBySide>>;
```

Reads the best prices of several outcome tokens and sides in one request, as an object by
token id (without leading zeros) and then by side. Every token and side asked has an entry:
the price, or `null` when that side of the book is empty or the order book does not know the
token. See [fetchPrice](PublicClient.md#fetchprice) for what a side reads. No credentials are sent.

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchPrices`](PublicClient.md#fetchprices)

***

### fetchProfile()

```ts
fetchProfile(options?): Promise<Profile>;
```

Reads the account's own profile: its username, wallet, points, tier, socials and standing.
Positions and activity are not part of it: see [listPositions](#listpositions) and
[listActivity](#listactivity).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`Profile`](../type-aliases/Profile.md)\>

#### Throws

`invalid_request_options` for bad options, `client_closed` after
  [close](#close) or [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const profile = await client.fetchProfile();
console.log(profile.username, profile.tier, profile.convictionPoints);
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchPublicProfile`](PublicClient.md#fetchpublicprofile)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchPulseStats`](PublicClient.md#fetchpulsestats)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchRewardGroup`](PublicClient.md#fetchrewardgroup)

***

### fetchRewardsLeaderboardStanding()

```ts
fetchRewardsLeaderboardStanding(request?, options?): Promise<RewardsLeaderboardStanding>;
```

Reads where the account stands on the liquidity leaderboard of a period: its rank and what
it earned. An account that is not ranked gets a 404, which XO also answers when it cannot
read the leaderboard for now: ask again before you conclude.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`FetchRewardsLeaderboardStandingRequest`](../type-aliases/FetchRewardsLeaderboardStandingRequest.md) | The `period`, `weekly` by default. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`RewardsLeaderboardStanding`](../type-aliases/RewardsLeaderboardStanding.md)\>

#### Throws

`invalid_input` for a request that is not
  valid, `invalid_request_options` for bad options, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), a 404 `RequestRejectedError` when the account is not ranked,
  and the read errors.

#### Example

```ts
const standing = await client.fetchRewardsLeaderboardStanding({ period: 'weekly' });
console.log(standing.rank, standing.liquidityCp);
```

***

### fetchSeries()

```ts
fetchSeries(request, options?): Promise<Series>;
```

Reads one series. Its events are listed by [listEvents](PublicClient.md#listevents) with a `seriesId`, and its
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchSeries`](PublicClient.md#fetchseries)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchSmartWalletAddress`](PublicClient.md#fetchsmartwalletaddress)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchSpread`](PublicClient.md#fetchspread)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchSpreads`](PublicClient.md#fetchspreads)

***

### fetchTradingApprovalsState()

```ts
fetchTradingApprovalsState(options?): Promise<TradingApprovalsState>;
```

Reads on chain what the account has set up for trading: whether it exists (a smart wallet is
made by its first transaction), whether the exchange may spend its USDC and move its outcome
tokens, and so whether it is `ready`. Nothing is sent. When it is not ready,
[setupTradingApprovals](#setuptradingapprovals) sets it up.

The reads are of the chain: `signal` and `timeout` bound the whole of it, and the chain
reads retry on their own, so `retries` does not change them.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel and timeout of the reads. |

#### Returns

`Promise`\<[`TradingApprovalsState`](../type-aliases/TradingApprovalsState.md)\>

#### Throws

`invalid_request_options` for bad options,
  `client_closed` after [close](#close) or [endAuthentication](#endauthentication), a `RequestAbortedError`
  or `TimeoutError` from the options, and an `XoError` `chain_read_failed` when the chain
  cannot be read.

#### Example

```ts
const state = await client.fetchTradingApprovalsState();
if (!state.ready) {
  await client.setupTradingApprovals();
}
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`fetchTradingState`](PublicClient.md#fetchtradingstate)

***

### fetchUserPnl()

#### Call Signature

```ts
fetchUserPnl(request?, options?): Promise<UserPnl>;
```

Reads the profit and loss of the whole account: the totals, and the positions behind them.
Pass a `marketId` for one market, or a `positionId` for one position, instead.

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`FetchUserPnlRequest`](../type-aliases/FetchUserPnlRequest.md) | Nothing, for the whole account. See [FetchUserPnlRequest](../type-aliases/FetchUserPnlRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

##### Returns

`Promise`\<[`UserPnl`](../type-aliases/UserPnl.md)\>

##### Throws

`invalid_input` for a request that is not valid (a `marketId`
  and a `positionId` together), `invalid_request_options` for bad options, `client_closed`
  after [close](#close) or [endAuthentication](#endauthentication), a 404 `RequestRejectedError` for a market
  or a position that is not the account's, and the read errors.

##### Example

```ts
const pnl = await client.fetchUserPnl();
console.log(pnl.pnl, pnl.openPositions, pnl.positions.length);
```

#### Call Signature

```ts
fetchUserPnl(request, options?): Promise<MarketPnl>;
```

Reads the profit and loss of the account's positions in one market.

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchMarketPnlRequest`](../type-aliases/FetchMarketPnlRequest.md) | The market's `marketId`: XO's id for it. See [FetchMarketPnlRequest](../type-aliases/FetchMarketPnlRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

##### Returns

`Promise`\<[`MarketPnl`](../type-aliases/MarketPnl.md)\>

##### Throws

As for the whole account, and a 404 `RequestRejectedError` when
  the account has no position in the market.

##### Example

```ts
const pnl = await client.fetchUserPnl({ marketId: market.id });
console.log(pnl.title, pnl.pnl);
```

#### Call Signature

```ts
fetchUserPnl(request, options?): Promise<PositionPnl>;
```

Reads the profit and loss of one position of the account.

##### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`FetchPositionPnlRequest`](../type-aliases/FetchPositionPnlRequest.md) | The position's `positionId`, as a [Position](../type-aliases/Position.md) gives it. See [FetchPositionPnlRequest](../type-aliases/FetchPositionPnlRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

##### Returns

`Promise`\<[`PositionPnl`](../type-aliases/PositionPnl.md)\>

##### Throws

As for the whole account, and a 404 `RequestRejectedError` for a
  position that is not the account's.

##### Example

```ts
const pnl = await client.fetchUserPnl({ positionId: position.positionId });
console.log(pnl.outcome, pnl.pnl, pnl.percentPnl);
```

***

### fetchUserRewards()

```ts
fetchUserRewards(request?, options?): Promise<UserRewards>;
```

Reads what the account's wallet has earned from liquidity rewards, or any wallet given as
`user`: in each currency the total received, what came from liquidity and what is accruing
on the open day. A wallet that has earned nothing reads zeros. Every figure is rounded to
two decimals. The account's own is read with its key.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`SecureFetchUserRewardsRequest`](../type-aliases/SecureFetchUserRewardsRequest.md) | The `user` wallet, or nothing for the account's own. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`UserRewards`](../type-aliases/UserRewards.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const rewards = await client.fetchUserRewards();
console.log(rewards.usdc?.totalReceived, rewards.cp?.totalReceived);
```

#### Overrides

[`PublicClient`](PublicClient.md).[`fetchUserRewards`](PublicClient.md#fetchuserrewards)

***

### fetchUserRewardsEpoch()

```ts
fetchUserRewardsEpoch(request?, options?): Promise<UserRewardsEpoch>;
```

Reads one UTC day of the rewards of the account's wallet, or of any wallet given as `user`,
across every market it made liquidity in: for each market the score, the share of the pot
and the payout.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`SecureFetchUserRewardsEpochRequest`](../type-aliases/SecureFetchUserRewardsEpochRequest.md) | The `user` wallet (the account's own when left out) and the `epoch`. See [SecureFetchUserRewardsEpochRequest](../type-aliases/SecureFetchUserRewardsEpochRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`UserRewardsEpoch`](../type-aliases/UserRewardsEpoch.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const day = await client.fetchUserRewardsEpoch({ epoch: 20_743 });
console.log(day.effectiveCp, day.markets.map((market) => market.conditionId));
```

#### Overrides

[`PublicClient`](PublicClient.md).[`fetchUserRewardsEpoch`](PublicClient.md#fetchuserrewardsepoch)

***

### fetchUserStats()

```ts
fetchUserStats(request?, options?): Promise<UserStats>;
```

Reads the trading statistics of the account: profit and loss, volume and the number of
markets traded. With a `username`, it reads that user's, as a public client does.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`SecureFetchUserStatsRequest`](../type-aliases/SecureFetchUserStatsRequest.md) | A user's `username`, or nothing for the account's own. See [SecureFetchUserStatsRequest](../type-aliases/SecureFetchUserStatsRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`UserStats`](../type-aliases/UserStats.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), a 404 `RequestRejectedError` when XO has no such user, and the
  read errors.

#### Example

```ts
const stats = await client.fetchUserStats();
console.log(stats.pnl, stats.volume, stats.tradedMarketCount);
```

#### Overrides

[`PublicClient`](PublicClient.md).[`fetchUserStats`](PublicClient.md#fetchuserstats)

***

### listAccountTrades()

```ts
listAccountTrades(request?, options?): Paginated<Trade>;
```

Lists the account's trades, newest first, a page at a time: each fill of its orders, as
the maker or as the taker. XO keeps the latest 500. XO filters by `market`; the outcome
(`assetId`) and the time window (`after`, `before`) are kept here, from the pages XO sends,
so a page can hold fewer trades than XO sent, even none, and still have more after it.

Reading the list makes one request per page. Nothing is requested until the list is read.
A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListAccountTradesRequest`](../type-aliases/ListAccountTradesRequest.md) | The `market` (a condition id), the outcome (`assetId`), and the window: matched at or `after` a time and `before` another, each optional. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Trade`](../type-aliases/Trade.md)\>

#### Throws

`invalid_input` for a request that is not valid (a time in
  milliseconds, say), `invalid_request_options` for bad options, `invalid_cursor` for a
  cursor this list did not give out, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the read errors when a page fails.

#### Example

```ts
const trades = client.listAccountTrades({ market: conditionId });
const page = await trades.firstPage();
console.log(page.items.map((trade) => `${trade.side} ${trade.size} @ ${trade.price}`));
```

***

### listActivity()

```ts
listActivity(request?, options?): Paginated<Activity>;
```

Lists the account's activity, newest first, a page at a time: its buys and sells, with each
one's transaction, shares, price and realised profit, and its redemptions, splits, merges
and transfers. `type` and `marketId` narrow it; a `type` other than `REDEEM` is kept here
from the pages XO sends, so a page can hold fewer rows than XO sent, even none, and still
have more after it.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListActivityRequest`](../type-aliases/ListActivityRequest.md) | The filters and the page size. See [ListActivityRequest](../type-aliases/ListActivityRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Activity`](../type-aliases/Activity.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
  of this list, `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the read
  errors when a page fails.

#### Example

```ts
const page = await client.listActivity({ type: 'TRADE' }).firstPage();
for (const row of page.items) {
  console.log(row.timestamp, row.side, row.shares, row.price, row.transactionHash);
}
```

***

### listApiKeys()

```ts
listApiKeys(options?): Paginated<ApiKey>;
```

Lists the account's API keys, newest first, on one page: each key's id, name, prefix,
scopes and dates, never the key itself. Revoked and expired keys are listed too. XO lists at
most the 100 newest. A key can be revoked only by itself: the client revokes the key it uses
with [endAuthentication](#endauthentication), or replaces it with [rotateCredentials](#rotatecredentials).

Nothing is requested until the list is read. A bad option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`ApiKey`](../type-aliases/ApiKey.md)\>

#### Throws

`invalid_request_options` for bad options, `invalid_cursor` for
  any cursor (the list has one page), `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const page = await client.listApiKeys().firstPage();
console.log(page.items.map((key) => `${key.id} ${key.name} ${key.revokedAt ?? 'active'}`));
```

***

### listBridgeAssets()

```ts
listBridgeAssets(request, options?): Paginated<BridgeAsset>;
```

Lists the tokens a deposit can be paid in (`deposit`), or a withdrawal can deliver
(`withdraw`), on one page. A deposit lands as USDC in the trading wallet whatever it is paid
in. Pass an asset's `assetId` to a quote.

Nothing is requested until the list is read. A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ListBridgeAssetsRequest`](../type-aliases/ListBridgeAssetsRequest.md) | The `direction`. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`BridgeAsset`](../type-aliases/BridgeAsset.md)\>

#### Throws

`invalid_input` for a direction that is neither,
  `invalid_request_options` for bad options, `invalid_cursor` for any cursor (the list has
  one page), `bridge_not_available` on an environment without deposits, `client_closed`
  after [close](#close) or [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const page = await client.listBridgeAssets({ direction: 'deposit' }).firstPage();
console.log(page.items.map((asset) => `${asset.symbol} on ${asset.chain}: ${asset.assetId}`));
```

***

### listBridgePayments()

```ts
listBridgePayments(request?, options?): Paginated<BridgePayment>;
```

Lists the account's deposits and withdrawals, newest first, a page at a time. A quote nobody
confirmed is not listed.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListBridgePaymentsRequest`](../type-aliases/ListBridgePaymentsRequest.md) | The `direction` and the `status` to list, each optional. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`BridgePayment`](../type-aliases/BridgePayment.md)\>

#### Throws

`invalid_input` for a request that is not valid (the
  status `QUOTED` included), `invalid_request_options` for bad options, `invalid_cursor` for a
  cursor that is not a page of this list, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the read errors when a page fails.

#### Example

```ts
for await (const page of client.listBridgePayments({ direction: 'withdraw' })) {
  console.log(page.items.map((payment) => `${payment.paymentId} ${payment.status}`));
}
```

***

### listBrowseItems()

```ts
listBrowseItems(request?, options?): Paginated<BrowseItem>;
```

Lists the cards of XO's market page: markets that stand alone, and events with their
markets, in the page's own trending order. [listMarkets](PublicClient.md#listmarkets) cannot give this: it lists
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listBrowseItems`](PublicClient.md#listbrowseitems)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listCategories`](PublicClient.md#listcategories)

***

### listEvents()

```ts
listEvents(request?, options?): Paginated<Event>;
```

Lists events, a page at a time: the events that are not sub-events of another. Reading the
list makes one request per page.

An event in a list has no markets (`markets` is `null`) unless `withMarkets` asks for them.
[fetchEvent](PublicClient.md#fetchevent) loads them for one event.

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listEvents`](PublicClient.md#listevents)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listMarketRewardsMakers`](PublicClient.md#listmarketrewardsmakers)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listMarketRewardsOrders`](PublicClient.md#listmarketrewardsorders)

***

### listMarkets()

```ts
listMarkets(request?, options?): Paginated<Market>;
```

Lists CLOB markets with two outcomes, a page at a time. Without `status` it lists open
(`active`) markets only; pass `status: 'closed'` or `'resolved'` for the others.

Reading the list makes one request per page. A market in a list has only what the list
carries: the fields that need the order book, the fee policy or the rewards programme are
`null` (see [fetchMarket](PublicClient.md#fetchmarket), which fills them). Rows that are not CLOB markets with two
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listMarkets`](PublicClient.md#listmarkets)

***

### listOpenOrders()

```ts
listOpenOrders(request?, options?): Paginated<OpenOrder>;
```

Lists the account's orders that rest on the book, a page at a time, filtered by `market`
or by outcome (`assetId`) when given. An order that waits out the taker delay is not
listed: [fetchOrder](#fetchorder) finds it by its hash.

Reading the list makes one request per page. Nothing is requested until the list is read.
A bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListOpenOrdersRequest`](../type-aliases/ListOpenOrdersRequest.md) | The `market` (a condition id) and the outcome (`assetId`), each optional. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`OpenOrder`](../type-aliases/OpenOrder.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor this list did
  not give out, `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the
  read errors when a page fails.

#### Example

```ts
for await (const page of client.listOpenOrders({ market: conditionId })) {
  console.log(page.items.map((order) => `${order.side} ${order.originalSize} @ ${order.price}`));
}
```

***

### listPositions()

```ts
listPositions(request?, options?): Paginated<Position>;
```

Lists the positions of the client's own wallet, a page at a time, or of any wallet given as
`user`: what it holds in each outcome of each market, with the value and the profit or
loss, and whether it can be redeemed. The client's own positions are read with its key; any
other wallet's are public, and read without it.

`redeemable: true` lists only the positions the SDK can redeem now, with
[redeemPositions](#redeempositions) or [redeemAllPositions](#redeemallpositions): their market is resolved or voided,
the winnings are not claimed, and the market is one of the order book. A settled position
of an older market type pays out on that market's own contract, which these do not redeem
on: it is listed with `status: 'REDEEMABLE'` and `redeemable: false`. `market` lists the
positions of one market. Both are kept here from the pages XO sends, so a page can hold
fewer positions than XO sent, even none, and still have more after it. What the order book
holds for trading now is [fetchBalances](#fetchbalances).

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`SecureListPositionsRequest`](../type-aliases/SecureListPositionsRequest.md) | The `user` wallet (the client's own when left out), and the filters. See [SecureListPositionsRequest](../type-aliases/SecureListPositionsRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`Position`](../type-aliases/Position.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
  of this list, `client_closed` after [close](#close) or [endAuthentication](#endauthentication), a 404
  `RequestRejectedError` for a `user` XO does not know, and the read errors when a page
  fails.

#### Example

```ts
for await (const page of client.listPositions({ redeemable: true })) {
  console.log(page.items.map((position) => `${position.title}: ${position.currentSize}`));
}
```

#### Overrides

[`PublicClient`](PublicClient.md).[`listPositions`](PublicClient.md#listpositions)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listPriceHistory`](PublicClient.md#listpricehistory)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listPulseMarkets`](PublicClient.md#listpulsemarkets)

***

### listRewardGroups()

```ts
listRewardGroups(request?, options?): Paginated<RewardGroup>;
```

Lists the Pulse groups, a page at a time. A group is one shared reward pool for all the short
rounds of a product, such as one pot for every five-minute window of a price market. A group
in a list has only what the list carries: `day`, `totalScoredLiquidity` and `lifetime` are
`null` (see [fetchRewardGroup](PublicClient.md#fetchrewardgroup), which fills them).

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listRewardGroups`](PublicClient.md#listrewardgroups)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listRewardPools`](PublicClient.md#listrewardpools)

***

### listRewardsLeaderboard()

```ts
listRewardsLeaderboard(request?, options?): Paginated<RewardsLeaderboardEntry>;
```

Lists the makers by the liquidity rewards they earned in a period, best first, a page at a
time, each with the profile of its wallet. XO shows the leaderboard to signed-in accounts.
An empty leaderboard can also mean XO could not read it for now: ask again before you
conclude that nobody earned.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`ListRewardsLeaderboardRequest`](../type-aliases/ListRewardsLeaderboardRequest.md) | The `period` (`weekly` by default) and the page size. See [ListRewardsLeaderboardRequest](../type-aliases/ListRewardsLeaderboardRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`RewardsLeaderboardEntry`](../type-aliases/RewardsLeaderboardEntry.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
  of this list, `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the read
  errors when a page fails.

#### Example

```ts
const page = await client.listRewardsLeaderboard({ period: 'daily' }).firstPage();
console.log(page.items.map((entry) => `${entry.rank} ${entry.username ?? entry.wallet} ${entry.liquidityCp}`));
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listSeries`](PublicClient.md#listseries)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listSubcategories`](PublicClient.md#listsubcategories)

***

### listSubevents()

```ts
listSubevents(request, options?): Paginated<Event>;
```

Lists the sub-events of an event, for example the first half of a match. Each is an event
of its own, with `parentEventId` set and its markets not loaded: [fetchEvent](PublicClient.md#fetchevent) loads
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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listSubevents`](PublicClient.md#listsubevents)

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

#### Inherited from

[`PublicClient`](PublicClient.md).[`listTrades`](PublicClient.md#listtrades)

***

### listUserRewardsOrders()

```ts
listUserRewardsOrders(request?, options?): Paginated<RewardsOrder>;
```

Lists the orders of the account's wallet that were scored for rewards, or of any wallet
given as `user`, a page at a time, each with its market, price, score, how it ended and what
it paid per currency.

Reading the list makes one request per page. Nothing is requested until the list is read. A
bad request or option throws at once.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`SecureListUserRewardsOrdersRequest`](../type-aliases/SecureListUserRewardsOrdersRequest.md) | The `user` wallet (the account's own when left out) and the filters. See [SecureListUserRewardsOrdersRequest](../type-aliases/SecureListUserRewardsOrdersRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

[`Paginated`](../type-aliases/Paginated.md)\<[`RewardsOrder`](../type-aliases/RewardsOrder.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `invalid_cursor` for a cursor that is not a page
  of this list, `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the read
  errors when a page fails.

#### Example

```ts
const page = await client.listUserRewardsOrders({ epoch: 20_743 }).firstPage();
console.log(page.items.map((order) => order.payouts));
```

#### Overrides

[`PublicClient`](PublicClient.md).[`listUserRewardsOrders`](PublicClient.md#listuserrewardsorders)

***

### mergePositions()

```ts
mergePositions(request): Promise<TransactionHandle>;
```

Merges YES and NO shares of one market back into USDC: an amount of YES and the same amount
of NO are burnt for that many USDC, in one transaction. Without `amount`, it merges all it
can: as many full sets as are free of both outcomes on the order book (shares held by
resting sell orders are not free). Stop quoting the market first: an order matched while
the merge is on its way can be left without its shares.

The transaction is sent once, never again and never signed again, and the call returns once
the chain has mined it: a reverted merge is a result (`wait()` says `reverted`). When its
outcome is unknown it throws with `mayHaveLanded: true` and the `transactionHash` (or the
executor `nonce`): look it up before you merge again.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`MergePositionsRequest`](../type-aliases/MergePositionsRequest.md) | The market's `conditionId`, and the `amount` of full sets, in whole shares. |

#### Returns

`Promise`\<[`TransactionHandle`](TransactionHandle.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `nothing_to_merge` when none of one outcome is free and `amount_exceeds_free` above what
  is (nothing is sent), `client_closed` after [close](#close) or [endAuthentication](#endauthentication),
  the errors of reading the order book, the sponsor's refusals, and a
  `TransactionFailedError` with `mayHaveLanded: true` when the outcome is unknown.

#### Example

```ts
const transaction = await client.mergePositions({ conditionId, amount: '5' });
console.log((await transaction.wait()).status);
```

***

### placeLimitOrder()

```ts
placeLimitOrder(request): Promise<OrderResponse>;
```

Builds, signs and sends a limit order. It is sent once: never again, and never signed
again.

The result says what XO answered. `{ ok: true }` when XO accepted the order, with its
`orderId`, its `status` (`live` when it rests, `matched` when it filled at once, `delayed`
while it waits out the taker delay, when it can still fill) and what filled at once.
`{ ok: false, code, message }` when XO refused it: nothing was placed, and `code` says why,
such as `insufficient_balance` or `trading_paused`. Both carry the order's `orderHash`.

When XO's answer is lost or cannot be read (a timeout, a broken connection, a 5xx), the
order may be on the book: it throws with `mayHaveLanded: true` and the `orderHash`. Never
place that order again; look it up with [reconcileOrder](#reconcileorder).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`CreateLimitOrderRequest`](../type-aliases/CreateLimitOrderRequest.md) | The outcome token (`assetId`), the `side`, the `price` and the `size`, and `postOnly` and `expiration` when wanted. See [CreateLimitOrderRequest](../type-aliases/CreateLimitOrderRequest.md). |

#### Returns

`Promise`\<[`OrderResponse`](../type-aliases/OrderResponse.md)\>

#### Throws

The errors of [createLimitOrder](#createlimitorder), before anything is
  sent; with `mayHaveLanded: false`, credentials XO refused (401), a placement it forbids
  (403) and too many requests (a 429 `RateLimitError`); and with `mayHaveLanded: true` and
  the `orderHash`, every failure after which the order may have been placed.

#### Example

```ts
const response = await client.placeLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: '0.52',
  size: 10,
});
console.log(response.ok ? response.orderId : response.code);
```

***

### placeMarketOrder()

```ts
placeMarketOrder(request): Promise<OrderResponse>;
```

Builds, signs and sends a market order, once: see [createMarketOrder](#createmarketorder) for the order
and [placeLimitOrder](#placelimitorder) for the result. A taker order often answers `status: 'delayed'`:
it waits out the taker delay and can still fill, so it is not a refusal. Read what filled
with [listAccountTrades](#listaccounttrades), or look the order up with [reconcileOrder](#reconcileorder).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`CreateMarketOrderRequest`](../type-aliases/CreateMarketOrderRequest.md) | The outcome token (`assetId`), the `side`, the `amount` of a buy or the `shares` of a sell, and `maxPrice` or `minPrice` when wanted. See [CreateMarketOrderRequest](../type-aliases/CreateMarketOrderRequest.md). |

#### Returns

`Promise`\<[`OrderResponse`](../type-aliases/OrderResponse.md)\>

#### Throws

The errors of [createMarketOrder](#createmarketorder), before anything is
  sent, and those of sending the order, as for [placeLimitOrder](#placelimitorder): when
  `mayHaveLanded` is `true`, never place it again; look it up with [reconcileOrder](#reconcileorder).

#### Example

```ts
const response = await client.placeMarketOrder({
  assetId,
  side: OrderSide.SELL,
  shares: 5,
  minPrice: '0.4',
});
console.log(response.ok ? response.status : response.code);
```

***

### postOrder()

```ts
postOrder(order): Promise<OrderResponse>;
```

Sends one order that [createLimitOrder](#createlimitorder) or [createMarketOrder](#createmarketorder) signed. It is
sent once, with the results of [placeLimitOrder](#placelimitorder). Before it is sent, its hash is
checked against the order, so an order changed after signing is refused. The same signed
order sent again is refused with `duplicate_order`.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `order` | [`SignedOrder`](SignedOrder.md) | The signed order. |

#### Returns

`Promise`\<[`OrderResponse`](../type-aliases/OrderResponse.md)\>

#### Throws

`invalid_input` for something that is not a signed order (nothing
  is sent), `client_closed` after [close](#close) or [endAuthentication](#endauthentication); with
  `mayHaveLanded: false`, credentials XO refused (401), a placement it forbids (403) and too
  many requests (a 429 `RateLimitError`); and with `mayHaveLanded: true` and the
  `orderHash`, every failure after which the order may have been placed.

#### Example

```ts
const order = await client.createLimitOrder({
  assetId,
  side: OrderSide.SELL,
  price: '0.6',
  size: 10,
});
const response = await client.postOrder(order);
console.log(response.ok ? response.status : response.code);
```

***

### postOrderBatch()

```ts
postOrderBatch(request): Promise<BatchOperationResult[]>;
```

Places and cancels orders in one request: the operations run in the order given, and one
that fails does not undo the others. It is sent once. Each operation gets its result, in
order: the result of each order placed, as for [postOrders](#postorders), or what a cancel did.
When XO refuses the whole request for good before running any of it (trading paused, a
malformed request), each order is refused and each cancel not made, with that reason.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`PostOrderBatchRequest`](../type-aliases/PostOrderBatchRequest.md) | The `operations`: `{ type: 'place', orders }` with signed orders, or `{ type: 'cancel', orderIds }`. See [PostOrderBatchRequest](../type-aliases/PostOrderBatchRequest.md). |

#### Returns

`Promise`\<[`BatchOperationResult`](../type-aliases/BatchOperationResult.md)[]\>

#### Throws

`invalid_input` for operations that are not valid (nothing is
  sent), `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and a
  `BatchOpsIncompleteError` for any other failure. When its `mayHaveLanded` is `true`, the
  orders of its `orderHashes` may have been placed: never send them again; look each up
  with [reconcileOrder](#reconcileorder), and read the open orders again. When XO answered without
  saying what became of some orders, its `results` are what each operation did, as this
  call returns them, but for those orders (match the orders of a place operation by
  `orderHash`, not by position).

#### Example

```ts
const replacement = await client.createLimitOrder({
  assetId,
  side: OrderSide.BUY,
  price: '0.51',
  size: 10,
});
const results = await client.postOrderBatch({
  operations: [
    { type: 'cancel', orderIds: [orderId] },
    { type: 'place', orders: [replacement] },
  ],
});
console.log(results.map((result) => result.type));
```

***

### postOrders()

```ts
postOrders(orders): Promise<OrderResponse[]>;
```

Sends signed orders in batches of at most 300, one batch after the other, each once. Every
order gets its result, in the order given: accepted (`ok: true`) or refused (`ok: false`
with its `code`). XO does not report what filled per order of a batch: an accepted order
has `makingAmount`, `takingAmount`, `tradeIds` and `transactionsHashes` all `null` (not
reported, which is not "none"); read the account's trades for them. When XO refuses a batch
as a whole for good (trading paused, a malformed batch) and no order is left unsent, each
order of that batch is refused with that code. The same signed order twice is refused
before anything is sent.

An order whose entry in XO's answer does not say what became of it, in words the SDK knows
for a refusal, is not given a result: it may have been placed, and the call throws.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `orders` | [`SignedOrder`](SignedOrder.md)[] | The signed orders: at least one. |

#### Returns

`Promise`\<[`OrderResponse`](../type-aliases/OrderResponse.md)[]\>

#### Throws

`invalid_input` for an empty list, a duplicate or something that is
  not a signed order (nothing is sent); `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication); and a `BatchPlaceIncompleteError` when a batch failed, or when
  XO answered without saying what became of some orders. Its `results` are the results so
  far, as this call returns them, of the orders XO answered for (an order whose fate it did
  not say has none, so match a result to its order by `orderHash`, not by position),
  `notSent` the orders not sent, and `failedChunk` the orders that may
  have been placed when `mayHaveLanded` is `true`: never send those again; look each up with
  [reconcileOrder](#reconcileorder). When a batch was answered with such an order and a later batch
  failed, the error lists those orders (and the later batch's, when they may have been
  placed too), with `mayHaveLanded: true`; the failure of the later batch is its `cause`,
  whose `failedChunk` and `mayHaveLanded` say what became of that batch.

#### Example

```ts
const orders = [
  await client.createLimitOrder({ assetId, side: OrderSide.BUY, price: '0.5', size: 10 }),
  await client.createLimitOrder({ assetId, side: OrderSide.SELL, price: '0.6', size: 10 }),
];
const responses = await client.postOrders(orders);
console.log(responses.map((response) => response.ok));
```

***

### quoteDeposit()

```ts
quoteDeposit(request, options?): Promise<DepositQuote[]>;
```

Asks for the ways to deposit an amount of a token into XO: each quote says what goes in,
what lands in the trading wallet (USDC) and what it costs, the one that lands the most first.
A quote moves nothing; confirm one with [createDeposit](#createdeposit) before its `acceptBy`.

A quote is a read: it is retried like one. The quotes carry no minimum or maximum: an amount
the bridge does not take fails with `amount_out_of_range`, whose message names the bounds.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`QuoteDepositRequest`](../type-aliases/QuoteDepositRequest.md) | The `assetId` to pay in and the `amount`, in whole units of it. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`DepositQuote`](../type-aliases/DepositQuote.md)[]\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, a 400 `RequestRejectedError`
  (`asset_not_supported`, `amount_out_of_range`, `amount_invalid`), `bridge_not_available`,
  `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const [best] = await client.quoteDeposit({ assetId, amount: '25' });
console.log(best?.output.amount, best?.fees.total);
```

***

### quoteWithdrawal()

```ts
quoteWithdrawal(request, options?): Promise<WithdrawalQuote[]>;
```

Asks for the ways to withdraw an amount of USDC out of XO, delivered as a token to a
recipient: each quote says what leaves the trading wallet, what the recipient gets and what
it costs, the one that delivers the most first. A quote moves nothing; withdraw with one with
[withdraw](#withdraw) before its `acceptBy`. Check the recipient: a valid address that is wrong
cannot be undone.

A quote is a read: it is retried like one. The quotes carry no minimum or maximum: an amount
the bridge does not take fails with `amount_out_of_range`, whose message names the bounds.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`QuoteWithdrawalRequest`](../type-aliases/QuoteWithdrawalRequest.md) | The `assetId` to deliver, the `amount` of USDC and the `recipient`. See [QuoteWithdrawalRequest](../type-aliases/QuoteWithdrawalRequest.md). |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of the request. |

#### Returns

`Promise`\<[`WithdrawalQuote`](../type-aliases/WithdrawalQuote.md)[]\>

#### Throws

As [quoteDeposit](#quotedeposit), and a 400 `RequestRejectedError`
  `recipient_invalid` for an address that is not one on the asset's network.

#### Example

```ts
const [best] = await client.quoteWithdrawal({ assetId, amount: '25', recipient });
console.log(best?.output.amount, best?.recipient);
```

***

### reconcileOrder()

```ts
reconcileOrder(request, options?): Promise<ReconciledOrder>;
```

Finds out what became of an order that may have been placed, such as one whose placement
threw with `mayHaveLanded: true`: `resting` with the open order, `traded` with its trades
among the account's latest, or `not_found`. It looks the order up by its hash, then reads
up to three pages of the account's trades.

`not_found` is not proof that the order was not placed: the placement may still be on its
way, or the order traded before the trades read. Look again later, and never send or sign
the order again on the strength of it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`ReconcileOrderRequest`](../type-aliases/ReconcileOrderRequest.md) | The `orderHash` of the result or of the error. |
| `options?` | [`RequestOptions`](../type-aliases/RequestOptions.md) | Cancel, timeout and retries of each request. |

#### Returns

`Promise`\<[`ReconciledOrder`](../type-aliases/ReconciledOrder.md)\>

#### Throws

`invalid_input` for a hash that is not one,
  `invalid_request_options` for bad options, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the read errors.

#### Example

```ts
const found = await client.reconcileOrder({ orderHash });
console.log(found.state);
```

***

### redeemAllPositions()

```ts
redeemAllPositions(): Promise<RedemptionResult[]>;
```

Redeems every market the account can redeem, one transaction per market, one after the
other, and gives one result per market: `ok: true` with the mined transaction, or
`ok: false` with the error. A market that fails does not stop the others, with one
exception: after a send whose outcome is unknown nothing more is sent, since another
transaction could take its place, and every market after it is `skipped_after_ambiguous`.
Look that transaction up, then call again. Nothing to redeem gives an empty list.

Each transaction is sent once, never again and never signed again.

#### Returns

`Promise`\<[`RedemptionResult`](../type-aliases/RedemptionResult.md)[]\>

#### Throws

`client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), and the errors of reading which markets can be redeemed, before
  anything is sent. The failure of one market is its result, not a throw.

#### Example

```ts
const results = await client.redeemAllPositions();
for (const result of results) {
  console.log(result.conditionId, result.ok ? result.transaction.transactionHash : result.error.code);
}
```

***

### redeemPositions()

```ts
redeemPositions(request): Promise<TransactionHandle>;
```

Redeems the account's YES and NO shares of one resolved market for what they pay out, in one
transaction. The market must be resolved on chain: while it is not, nothing is sent. A
redeem with no shares pays nothing.

The transaction is sent once, never again and never signed again, and the call returns once
the chain has mined it: a reverted redeem is a result (`wait()` says `reverted`). When its
outcome is unknown it throws with `mayHaveLanded: true` and the `transactionHash` (or the
executor `nonce`): look it up before you redeem again.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`RedeemPositionsRequest`](../type-aliases/RedeemPositionsRequest.md) | The resolved market's `conditionId`. |

#### Returns

`Promise`\<[`TransactionHandle`](TransactionHandle.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `not_resolved` while the market is not resolved on chain (nothing is sent), `client_closed`
  after [close](#close) or [endAuthentication](#endauthentication), a `chain_read_failed` `XoError`, the
  sponsor's refusals, and a `TransactionFailedError` with `mayHaveLanded: true` when the
  outcome is unknown.

#### Example

```ts
const transaction = await client.redeemPositions({ conditionId });
console.log(transaction.transactionHash);
```

***

### rotateCredentials()

```ts
rotateCredentials(): Promise<void>;
```

Replaces the wallet's API key now: signs in for a new one, uses and stores it, then revokes
the old one. The order book credentials do not change. A key given in `credentials` is
never rotated.

#### Returns

`Promise`\<`void`\>

#### Throws

`credentials_provided` for a key given in `credentials`,
  `client_closed` after [close](#close) or [endAuthentication](#endauthentication), and the errors of
  signing in: the wallet's signature (`SigningError`), a refusal (`api_key_limit_reached`
  when the account has 10 active keys) and the request errors.

#### Example

```ts
await client.rotateCredentials();
const { backend } = await client.exportCredentials();
console.log(`now using key ${backend?.id}`);
```

***

### sendOrderHeartbeat()

```ts
sendOrderHeartbeat(): Promise<OrderHeartbeatResponse>;
```

Sends one order heartbeat, once, and says whether XO counted it (`tracked`). It is opt-in:
the client never sends one unless you ask.

One counted beat opts the whole account in to a dead-man switch: from then on, when no
counted beat arrives for 30 seconds, XO cancels every open order of the account, in every
market, placed by any process or key. There is no way to opt out again but silence: the
orders are then cancelled 30 to 35 seconds after the last counted beat. To keep beating,
use [startOrderHeartbeat](#startorderheartbeat). `tracked: false` means the beat did not count (the
credentials were not accepted), and the countdown was not reset.

#### Returns

`Promise`\<[`OrderHeartbeatResponse`](../type-aliases/OrderHeartbeatResponse.md)\>

#### Throws

`client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), an `UnexpectedResponseError` for an answer that cannot be read,
  and the request errors. A beat is never tried again: the next one is the retry.

#### Example

```ts
const { tracked } = await client.sendOrderHeartbeat();
console.log(tracked ? 'counted' : 'not counted');
```

***

### setupTradingApprovals()

```ts
setupTradingApprovals(): Promise<TransactionHandle | null>;
```

Sets the account up for trading: in one transaction, it lets the exchange spend the
account's USDC and move its outcome tokens, and makes a smart wallet that does not exist
yet. It reads what is missing first and sends only that, so calling it again is safe; when
nothing is missing it sends nothing and returns `null`. XO's sponsor pays the gas unless the
client uses the direct rail.

The transaction is sent once, never again and never signed again. The call returns once the
chain has mined it. When its outcome is unknown (the receipt did not come, or the sponsor's
answer was lost), it throws with `mayHaveLanded: true` and the `transactionHash` (or the
executor `nonce`) to look it up by: check before you call again.

#### Returns

`Promise`\<[`TransactionHandle`](TransactionHandle.md) \| `null`\>

#### Throws

`client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), a `chain_read_failed` `XoError` when the chain cannot be read,
  the sponsor's refusals (`mayHaveLanded: false`), a `TransactionFailedError` `tx_reverted`
  when the transaction was mined and reverted (call again: it reads the chain again), and a
  `TransactionFailedError` with `mayHaveLanded: true` when the outcome is unknown.

#### Example

```ts
const transaction = await client.setupTradingApprovals();
console.log(transaction === null ? 'set up already' : transaction.transactionHash);
```

***

### startOrderHeartbeat()

```ts
startOrderHeartbeat(request?): OrderHeartbeat;
```

Starts sending order heartbeats, at once and then every `intervalMs`, and returns the
running heartbeat at once (not a promise). Read [sendOrderHeartbeat](#sendorderheartbeat) first: the first
counted beat opts the whole account in to the cancel of every open order after 30 seconds
of silence. `stop()` stops sending and does not opt out: the orders are cancelled about 30
seconds after the last beat, including orders placed after `stop()`.

Each beat that does not count reaches `onMissed`, and the heartbeat goes on: when misses go
on for 30 seconds the orders are cancelled, so stop quoting. The timers never keep the
process alive. One heartbeat runs per client; [close](#close) stops it.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request?` | [`StartOrderHeartbeatRequest`](../type-aliases/StartOrderHeartbeatRequest.md) | `intervalMs`, from 1 000 to 20 000 (10 000 by default), and `onMissed`. |

#### Returns

[`OrderHeartbeat`](OrderHeartbeat.md)

#### Throws

At once: `invalid_input` for a request that is not valid,
  `heartbeat_already_running` while a heartbeat runs on this client (stop it first), and
  `client_closed` after [close](#close) or [endAuthentication](#endauthentication).

#### Example

```ts
const heartbeat = client.startOrderHeartbeat({
  onMissed: (error) => console.warn('heartbeat missed', error.code),
});
heartbeat.stop();
```

***

### subscribe()

```ts
subscribe<S>(specs): Promise<SubscriptionHandle<EventOf<S[number]>>>;
```

Streams live events of one or more topics through one handle, the account's included. Each
spec names a topic:

- `market`: the order books, price changes and fills of outcome tokens (`assetIds`) or of
  whole markets (`markets`, by condition id), as on a client without a wallet.
- `user`: the account's orders (`order` events: placed, filled, cancelled, rejected) and
  trades (`trade` events: the fill, then each step of its settlement), on every market.
- `portfolio`: the account's positions each time they change, as `listPositions` lists
  them, in the first 100 markets of the account.
- `activity`: the newest fills of one market, by XO's id for it (`marketId`).

The handle's loop yields the events of every topic, in the order they arrive, narrowed to
the topics asked for. A stream reconnects by itself but does not replay what it missed. The
handle's `'reconnected'` (`{ topic }`) and its errors (`error.topic`) name the topic they
concern: on `'reconnected'` and on `ws_events_dropped`, re-read the state of the topic named
(`listOpenOrders` for `user`, `fetchOrderBooks` for `market`, `listPositions` for
`portfolio`). `subscription_overflow` names no topic: re-read every one. A topic that stops
for good says so on `'error'` and the others go on. [close](#close) and
[endAuthentication](#endauthentication) close every handle: its loop ends and its `'closed'` fires.

The `user` topic sends the order book credentials over the WebSocket, so it refuses to run
in a browser.

#### Type Parameters

| Type Parameter |
| ------ |
| `S` *extends* readonly [`SubscriptionSpec`](../type-aliases/SubscriptionSpec.md)[] |

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `specs` | `S` & [`ExactSpecs`](../type-aliases/ExactSpecs.md)\<`S`\> | The topics, such as `[{ topic: 'user' }, { topic: 'market', assetIds }]`. See [SubscriptionSpec](../type-aliases/SubscriptionSpec.md). |

#### Returns

`Promise`\<[`SubscriptionHandle`](SubscriptionHandle.md)\<[`EventOf`](../type-aliases/EventOf.md)\<`S`\[`number`\]\>\>\>

#### Throws

`invalid_input` for specs that are not valid (an empty list, an
  unknown topic or key, a `market` spec with no id, an id that is not one) and for the
  `market` or `user` topic when the runtime has no `WebSocket` and none was passed;
  `browser_secret_refused` for the `user` topic in a browser; `client_closed` after
  [close](#close) or [endAuthentication](#endauthentication). Nothing is opened then.

#### Example

```ts
const handle = await client.subscribe([{ topic: 'user' }, { topic: 'portfolio' }]);
try {
  for await (const event of handle) {
    if (event.type === 'order') {
      console.log(event.kind, event.orderId, event.status);
    } else if (event.type === 'positions') {
      console.log(event.positions.length, 'positions');
    }
  }
} finally {
  await handle.close();
}
```

#### Overrides

[`PublicClient`](PublicClient.md).[`subscribe`](PublicClient.md#subscribe)

***

### transferErc20()

```ts
transferErc20(request): Promise<TransactionHandle>;
```

Sends an ERC-20 token from the trading wallet to an address, in one transaction: XO's USDC
when `token` is left out. The amount is in whole units of the token (`'5'` is 5 USDC); for
another token its decimals are read from the chain first. The balance is read before the
send, and when it is short nothing is sent.

The transaction is sent once, never again and never signed again, and the call returns once
the chain has mined it: a reverted transfer is a result (`wait()` says `reverted`). When its
outcome is unknown it throws with `mayHaveLanded: true` and the `transactionHash` (or the
executor `nonce`): look it up before you send again, or the tokens may go out twice.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`TransferErc20Request`](../type-aliases/TransferErc20Request.md) | The `to` address, the `amount` in whole units, and the `token` (XO's USDC by default). See [TransferErc20Request](../type-aliases/TransferErc20Request.md). |

#### Returns

`Promise`\<[`TransactionHandle`](TransactionHandle.md)\>

#### Throws

`invalid_input` for a request that is not valid, the zero
  address or a token contract as `to` (`recipient_is_token_contract`), an amount with more
  decimals than the token has, `insufficient_balance` (nothing is sent),
  `client_closed` after [close](#close) or [endAuthentication](#endauthentication), a `chain_read_failed`
  `XoError`, the sponsor's refusals, and a `TransactionFailedError` with
  `mayHaveLanded: true` when the outcome is unknown.

#### Example

```ts
const transaction = await client.transferErc20({ to: recipient, amount: '25' });
const receipt = await transaction.wait();
console.log(receipt.status, receipt.blockNumber);
```

***

### verifyBridgePayment()

```ts
verifyBridgePayment(request): Promise<BridgePayment>;
```

Finishes a payment that waits for the owner wallet's signatures (`NEEDS_VERIFICATION`), such
as a deposit that failed with `verification_required`. Every item is checked and shown to
`verify`, and nothing is signed unless it approves them all; the signatures are sent once. A
payment in any other status is returned as it is, with nothing asked, signed or sent, so it
is safe to call again.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`VerifyBridgePaymentRequest`](../type-aliases/VerifyBridgePaymentRequest.md) | The `paymentId`, and `verify`, which approves each item. |

#### Returns

`Promise`\<[`BridgePayment`](../type-aliases/BridgePayment.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `client_closed` after [close](#close) or [endAuthentication](#endauthentication), a 404
  `RequestRejectedError` `payment_not_found`, `verification_required` when `verify` did not
  approve, the signer's errors, and, with `mayHaveLanded: true`, a sending of the signatures
  whose answer was lost.

#### Example

```ts
const payment = await client.verifyBridgePayment({
  paymentId,
  verify: (item) => item.reason === 'EVM_OWNER',
});
console.log(payment.status);
```

***

### waitForBridgePayment()

```ts
waitForBridgePayment(request, options?): Promise<BridgePayment>;
```

Waits until a payment is final, reading it every 10 seconds, and returns it. A final payment
is not always a success: `COMPLETE` delivered, `EXPIRED` was not funded in time and
`TAINTED` will not complete. `HALTED` is waited out: it may still finish. A read that fails
because the service is down or slow is ridden out until the timeout. Waiting only reads: it
is safe to call again.

It takes a `signal` and a `timeout` for the whole wait, and no retries: it reads again by
itself.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`BridgePaymentRequest`](../type-aliases/BridgePaymentRequest.md) | The `paymentId`. |
| `options?` | [`WaitForBridgePaymentOptions`](../type-aliases/WaitForBridgePaymentOptions.md) | The `signal` that ends the wait, and the `timeout` of the whole wait (one hour by default, at most 24 hours). |

#### Returns

`Promise`\<[`BridgePayment`](../type-aliases/BridgePayment.md)\>

#### Throws

`invalid_input` for a request that is not valid,
  `invalid_request_options` for bad options, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), a `RequestAbortedError` when the signal aborts (its `cause` is
  the signal's reason), a `TimeoutError` `bridge_wait_timeout` when the payment was not final
  in time (it goes on), a 404 `RequestRejectedError` `payment_not_found`, and the read errors
  that are not ridden out.

#### Example

```ts
const payment = await client.waitForBridgePayment({ paymentId }, { timeout: 30 * 60_000 });
console.log(payment.status === 'COMPLETE' ? 'delivered' : payment.status);
```

***

### withdraw()

```ts
withdraw(request): Promise<BridgeWithdrawal>;
```

Withdraws from XO with a quote: it confirms the quote, checks that the payment delivers to
the quote's recipient and asks for exactly the quoted USDC, claims the payment's funding
once, and sends that USDC from the trading wallet once. The bridge then delivers the quoted
token to the recipient: follow it with [waitForBridgePayment](#waitforbridgepayment). Everything that can be
checked is checked before the claim (the balance included), and a failure there leaves
nothing claimed or sent.

Money moves once: the claim and the transfer are never repeated, and calling again for the
same quote after the claim fails with `bridge_funding_claimed` and sends nothing. After an
error with `mayHaveLanded: true`, read the payment with [fetchBridgePayment](#fetchbridgepayment) and look
the transfer up by its `transactionHash` (or `nonce`) before you send anything yourself. A
transfer that reverted is a result (`transaction.wait()` says `reverted`): the claim is used,
so send the payment's `deposit.amount` to its `deposit.address` yourself.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `request` | [`WithdrawRequest`](../type-aliases/WithdrawRequest.md) | The `quote`, and `verify` when the bridge may ask for signatures. |

#### Returns

`Promise`\<[`BridgeWithdrawal`](../type-aliases/BridgeWithdrawal.md)\>

#### Throws

`invalid_input` for a request that is not valid (a deposit quote
  included), `insufficient_balance`, `client_closed` after [close](#close) or
  [endAuthentication](#endauthentication), `bridge_funding_mismatch` for a payment the SDK will not fund
  (nothing claimed or sent), `bridge_funding_claimed` (`mayHaveLanded: true`) when the
  funding was claimed already, the rail's checks before the confirm
  (`previous_operation_pending` while an earlier transaction may still land), the bridge's
  refusals, and a `TransactionFailedError` with `mayHaveLanded: true`, the `paymentId` and the
  `transactionHash` or `nonce` when the transfer's outcome is unknown.

#### Example

```ts
const [quote] = await client.quoteWithdrawal({ assetId, amount: '25', recipient });
const { payment, transaction } = await client.withdraw({ quote });
console.log(payment.paymentId, (await transaction.wait()).status);
```
