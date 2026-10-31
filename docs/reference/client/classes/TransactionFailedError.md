# Class: TransactionFailedError

An on-chain transaction failed or its outcome is unknown. When `mayHaveLanded` is
true the transaction may still be mined, so it must be reconciled, never re-sent:
by `transactionHash` when it is known, otherwise by finding which transaction used `nonce`
from the executor.

## Extends

- [`XoError`](XoError.md)

## Constructors

### Constructor

```ts
new TransactionFailedError(message, opts): TransactionFailedError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `opts` | [`XoErrorOptions`](../interfaces/XoErrorOptions.md) & `object` |

#### Returns

`TransactionFailedError`

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

### mayHaveLanded

```ts
readonly mayHaveLanded: boolean;
```

Whether the operation may have taken effect although this error was thrown. Set on an
error from sending a signed order, on an error of a cancel request, on a
TransactionFailedError, and on every error of a deposit or a withdrawal (a read or a
check made before a request is `false`). When it is true, never resend or re-sign: reconcile
first (for an order, `reconcileOrder({ orderHash: error.orderHash })`; for a cancel, read
the open orders with `listOpenOrders()`). `undefined` on every other error.

#### Overrides

[`XoError`](XoError.md).[`mayHaveLanded`](XoError.md#mayhavelanded)

***

### nonce?

```ts
readonly optional nonce?: bigint;
```

The executor nonce the transaction was signed with, when one was. On
`previous_operation_pending` from the sponsored rail it is the nonce of the earlier
transaction the call was held back for.

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

***

### transactionHash?

```ts
readonly optional transactionHash?: `0x${string}`;
```

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
