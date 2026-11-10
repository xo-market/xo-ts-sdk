# Class: RequestRejectedError

A service answered with an HTTP error status other than 429: the request was refused
(400, 401, 403, 404, 409, 422) or the service failed (5xx). `status` says which, and `code`
is the service's own code, such as `trading_paused` (503), `frontend_only` or
`insufficient_scope` (403), `order_in_delay_window` (409) or `market_not_found` (404), or
`http_<status>` when the service sent none. A pause of trading is only this code on a 503:
there is no separate flag.

## Extends

- [`XoError`](XoError.md)

## Constructors

### Constructor

```ts
new RequestRejectedError(message, opts): RequestRejectedError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `opts` | [`XoErrorOptions`](../interfaces/XoErrorOptions.md) & `object` |

#### Returns

`RequestRejectedError`

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

### mayHaveLanded?

```ts
readonly mayHaveLanded?: boolean;
```

Whether the operation may have taken effect although this error was thrown. Set on an
error from sending a signed order, on an error of a cancel request, on a
[TransactionFailedError](TransactionFailedError.md), and on every error of a deposit or a withdrawal (a read or a
check made before a request is `false`). When it is true, never resend or re-sign: reconcile
first (for an order, `reconcileOrder({ orderHash: error.orderHash })`; for a cancel, read
the open orders with `listOpenOrders()`). `undefined` on every other error.

#### Inherited from

[`XoError`](XoError.md).[`mayHaveLanded`](XoError.md#mayhavelanded)

***

### orderHash?

```ts
readonly orderHash?: OrderHash;
```

The EIP-712 hash of the signed order whose placement threw, for `reconcileOrder`. Set on
the errors of placing or posting one order; `undefined` otherwise.

#### Inherited from

[`XoError`](XoError.md).[`orderHash`](XoError.md#orderhash)

***

### paymentId?

```ts
readonly paymentId?: string;
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
readonly requestId?: string;
```

#### Inherited from

[`XoError`](XoError.md).[`requestId`](XoError.md#requestid)

***

### retryAfter?

```ts
readonly retryAfter?: number;
```

How long the service asked callers to wait, in milliseconds, when it said so.

***

### service

```ts
readonly service: Service;
```

#### Inherited from

[`XoError`](XoError.md).[`service`](XoError.md#service)

***

### status

```ts
readonly status: number;
```

#### Overrides

[`XoError`](XoError.md).[`status`](XoError.md#status)

***

### topic?

```ts
readonly topic?: "market" | "user" | "portfolio" | "activity";
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
