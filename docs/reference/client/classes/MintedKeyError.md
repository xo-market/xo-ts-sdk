# Class: MintedKeyError

A login whose key request may have created a key that the SDK does not hold. Its `name`
stays `UnexpectedResponseError`.

- `mayHaveMinted: false`: the backend answered 201, so the key exists and counts toward
  the 10 active keys, but the answer could not be used. `keyId` is the key's id when the
  answer carried one.
- `mayHaveMinted: true`: the request failed without saying whether a key was made
  (no response, a timeout, a 5xx, a 2xx body that cannot be read). `keyId` is undefined
  and `cause` is the original error.

`keyId` is not a secret: it names the key in the account's key listing
(`listApiKeys()`). A key can revoke only itself, and the XO website has no
key-management page yet, so to revoke that key write to gm@xo.market, or let it expire. The
key itself is never kept. A session does not log in again for a while after this error, so a
broken or lost answer cannot mint a key on every call.

## Extends

- [`UnexpectedResponseError`](UnexpectedResponseError.md)

## Constructors

### Constructor

```ts
new MintedKeyError(message, opts): MintedKeyError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `opts` | [`XoErrorOptions`](../interfaces/XoErrorOptions.md) & `object` |

#### Returns

`MintedKeyError`

#### Overrides

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`constructor`](UnexpectedResponseError.md#constructor)

## Properties

### code

```ts
readonly code: string;
```

#### Inherited from

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`code`](UnexpectedResponseError.md#code)

***

### issues

```ts
readonly issues: unknown;
```

#### Inherited from

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`issues`](UnexpectedResponseError.md#issues)

***

### keyId?

```ts
readonly keyId?: string;
```

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

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`mayHaveLanded`](UnexpectedResponseError.md#mayhavelanded)

***

### mayHaveMinted

```ts
readonly mayHaveMinted: boolean;
```

***

### orderHash?

```ts
readonly orderHash?: OrderHash;
```

The EIP-712 hash of the signed order whose placement threw, for `reconcileOrder`. Set on
the errors of placing or posting one order; `undefined` otherwise.

#### Inherited from

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`orderHash`](UnexpectedResponseError.md#orderhash)

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

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`paymentId`](UnexpectedResponseError.md#paymentid)

***

### requestId?

```ts
readonly requestId?: string;
```

#### Inherited from

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`requestId`](UnexpectedResponseError.md#requestid)

***

### service

```ts
readonly service: Service;
```

#### Inherited from

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`service`](UnexpectedResponseError.md#service)

***

### status?

```ts
readonly status?: number;
```

#### Inherited from

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`status`](UnexpectedResponseError.md#status)

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

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`topic`](UnexpectedResponseError.md#topic)

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

A log-safe plain object. Fields that are `undefined` are left out.

#### Returns

`Record`\<`string`, `unknown`\>

#### Inherited from

[`UnexpectedResponseError`](UnexpectedResponseError.md).[`toJSON`](UnexpectedResponseError.md#tojson)
