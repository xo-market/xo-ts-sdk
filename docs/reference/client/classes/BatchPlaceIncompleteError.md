# Class: BatchPlaceIncompleteError

Placing a list of orders stopped because a batch failed, or XO answered without saying what
became of some orders. Nothing was retried. Sorted by the same rule as a single placement:

- `results`: the result of each order of the batches XO answered, as a placement returns it:
  `ok: true` for an order XO took, and `ok: false` with a `code` and XO's `message` for one it
  refused. An order whose entry did not say what became of it has no result here: it is in
  `failedChunk`. So match a result to its order by `orderHash`, not by position.
- `failedChunk`: the hashes of the batch whose request was sent and failed, or of the
  orders whose entry in an answer did not say what became of them (the engine took them
  and its answer was lost). When `mayHaveLanded` is true (a timeout, a network failure, a
  5xx, an answer that could not be read or paired, such an entry) any of them may have
  been placed, and may already have filled: never resend or re-sign them; reconcile each
  with `reconcileOrder`. When it is false XO refused the batch (a 4xx, or trading
  paused) and none of them was placed.
- `notSent`: the hashes of the orders that were not sent: the batches after the failed one,
  and the failed batch itself when it failed locally before sending.
- `cause`: the error of the failed batch. When answered orders whose fate is unknown are
  listed and a later batch failed too, the `cause` is the error of that later batch, with
  its own `failedChunk`, `notSent` and `mayHaveLanded`.

## Extends

- [`XoError`](XoError.md)

## Constructors

### Constructor

```ts
new BatchPlaceIncompleteError(message, opts): BatchPlaceIncompleteError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `opts` | \{ `cause`: `unknown`; `failedChunk`: [`OrderHash`](../type-aliases/OrderHash.md)[]; `mayHaveLanded`: `boolean`; `notSent`: [`OrderHash`](../type-aliases/OrderHash.md)[]; `results`: [`OrderResponse`](../type-aliases/OrderResponse.md)[]; \} |
| `opts.cause` | `unknown` |
| `opts.failedChunk` | [`OrderHash`](../type-aliases/OrderHash.md)[] |
| `opts.mayHaveLanded` | `boolean` |
| `opts.notSent` | [`OrderHash`](../type-aliases/OrderHash.md)[] |
| `opts.results` | [`OrderResponse`](../type-aliases/OrderResponse.md)[] |

#### Returns

`BatchPlaceIncompleteError`

#### Overrides

[`XoError`](XoError.md).[`constructor`](XoError.md#constructor)

## Properties

### code

```ts
readonly code: string;
```

#### Inherited from

[`XoError`](XoError.md).[`code`](XoError.md#code)

***

### failedChunk

```ts
readonly failedChunk: OrderHash[];
```

***

### mayHaveLanded

```ts
readonly mayHaveLanded: boolean;
```

Whether the operation may have taken effect although this error was thrown. Set on an
error from sending a signed order, on an error of a cancel request, on a
[TransactionFailedError](TransactionFailedError.md), and on every error of a deposit or a withdrawal (a read or a
check made before a request is `false`). When it is true, never resend or re-sign: reconcile
first (for an order, `reconcileOrder({ orderHash: error.orderHash })`; for a cancel, read
the open orders with `listOpenOrders()`). `undefined` on every other error.

#### Overrides

[`XoError`](XoError.md).[`mayHaveLanded`](XoError.md#mayhavelanded)

***

### notSent

```ts
readonly notSent: OrderHash[];
```

***

### orderHash?

```ts
readonly optional orderHash?: OrderHash;
```

The EIP-712 hash of the signed order whose placement threw, for `reconcileOrder`. Set on
the errors of placing or posting one order; `undefined` otherwise.

#### Inherited from

[`XoError`](XoError.md).[`orderHash`](XoError.md#orderhash)

***

### paymentId?

```ts
readonly optional paymentId?: string;
```

The id of the bridge payment the failed operation was about, for
`fetchBridgePayment({ paymentId })` and `waitForBridgePayment({ paymentId })`. Set on the
errors of reading a payment and on every error raised after a quote was confirmed;
`undefined` otherwise. When `mayHaveLanded` is true, read the payment by this id before
doing anything else, and never confirm the quote again.

#### Inherited from

[`XoError`](XoError.md).[`paymentId`](XoError.md#paymentid)

***

### requestId?

```ts
readonly optional requestId?: string;
```

#### Inherited from

[`XoError`](XoError.md).[`requestId`](XoError.md#requestid)

***

### results

```ts
readonly results: OrderResponse[];
```

***

### service

```ts
readonly service: Service;
```

#### Inherited from

[`XoError`](XoError.md).[`service`](XoError.md#service)

***

### status?

```ts
readonly optional status?: number;
```

#### Inherited from

[`XoError`](XoError.md).[`status`](XoError.md#status)

***

### topic?

```ts
readonly optional topic?: "market" | "user" | "portfolio" | "activity";
```

The topic an error of a live subscription is about: `'market'`, `'user'`, `'portfolio'` or
`'activity'`. Set on the errors a subscription handle reports, so you know whose state to
read again; `undefined` on `subscription_overflow`, which is about the whole handle, and on
every other error.

#### Inherited from

[`XoError`](XoError.md).[`topic`](XoError.md#topic)

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

A log-safe plain object. Fields that are `undefined` are left out.

#### Returns

`Record`\<`string`, `unknown`\>

#### Inherited from

[`XoError`](XoError.md).[`toJSON`](XoError.md#tojson)
