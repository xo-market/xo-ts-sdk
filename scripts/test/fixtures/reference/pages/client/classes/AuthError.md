# Class: AuthError

The server answered 401.

## Extends

- [`XoError`](XoError.md)

## Constructors

### Constructor

```ts
new AuthError(message, opts?): AuthError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `opts` | `XoErrorOptions` |

#### Returns

`AuthError`

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
readonly optional mayHaveLanded?: boolean;
```

Whether the operation may have taken effect although this error was thrown. Set on an
error from placing a signed order (the orderbook client attaches it), on a
`TransactionError`, and on every error that leaves `xo.bridge` (deposits and
withdrawals: a read or a check made before a request is `false`). When it is true, never
resend or re-sign: reconcile first (for an order, `reconcileOrder(error.orderHash)`).
`undefined` on every other error.

#### Inherited from

[`XoError`](XoError.md).[`mayHaveLanded`](XoError.md#mayhavelanded)

***

### orderHash?

```ts
readonly optional orderHash?: OrderHash;
```

The EIP-712 hash of the signed order whose placement threw, for `reconcileOrder`. Set by
the orderbook client on errors from placing one order; `undefined` otherwise.

#### Inherited from

[`XoError`](XoError.md).[`orderHash`](XoError.md#orderhash)

***

### paymentId?

```ts
readonly optional paymentId?: string;
```

The id of the bridge payment the failed operation was about, for `xo.bridge.get(paymentId)`
and `xo.bridge.wait(paymentId)`. Set by the bridge client on the errors of `get` and on
every error raised after a quote was confirmed; `undefined` otherwise. When `mayHaveLanded`
is true, read the payment by this id before doing anything else, and never confirm the
quote again.

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
