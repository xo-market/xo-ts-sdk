# Class: OrderbookClient

The client of the orderbook gateway.

The market-data reads need no credentials: they send none, and the auth provider of the
transport is never asked. A GET is retried like any read. The batch reads are POSTs, but
they only read, so they are retried too.

## Constructors

### Constructor

```ts
new OrderbookClient(o): OrderbookClient;
```

Checks the options and requests nothing (an own session logs in on the first L2 call).

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `o` | `OrderbookClientOptions` |

#### Returns

`OrderbookClient`

## Methods

### getMarkets()

```ts
getMarkets(options?): Paginator<OrderbookMarket>;
```

Every market the gateway knows (`GET /markets`), page by page. It is lazy: nothing is
fetched until you read it, and it ends at the gateway's `"LTE="` cursor.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `options` | [`GetMarketsOptions`](../interfaces/GetMarketsOptions.md) |

#### Returns

`Paginator`\<`OrderbookMarket`\>

#### Throws

At once, when `limit` is not a whole number from 1 to 500
  or an option is unknown.

***

### placeOrder()

```ts
placeOrder<P, S>(a): Promise<PlaceOrderResult>;
```

`createOrder` then `postOrder`. An error thrown after signing carries the order's
`orderHash` and `mayHaveLanded`, as `postOrder` describes: when `mayHaveLanded` is true,
never place it again, call `reconcileOrder(error.orderHash)`.

The markets come from [OrderbookClient.getMarkets](#getmarkets); the hash is an
[`OrderHash`](../type-aliases/OrderHash.md).

#### Type Parameters

| Type Parameter |
| ------ |
| `P` *extends* `string` \| `number` |
| `S` *extends* `string` \| `number` |

#### Returns

`Promise`\<`PlaceOrderResult`\>
