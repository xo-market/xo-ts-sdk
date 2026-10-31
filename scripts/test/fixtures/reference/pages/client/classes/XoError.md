# Class: XoError

The base class of every error the SDK throws.

`message`, `code` and `requestId` are run through the SDK's redaction, so an API key
that a server echoes back never ends up on the error. `toJSON()` redacts everything.
The raw response body is never stored.

## Extends

- `Error`

## Extended by

- [`AuthError`](AuthError.md)

## Constructors

### Constructor

```ts
new XoError(message, opts?): XoError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `opts` | `XoErrorOptions` |

#### Returns

`XoError`

#### Overrides

```ts
Error.constructor
```

## Properties

### code

```ts
readonly code: string;
```

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

***

### orderHash?

```ts
readonly optional orderHash?: OrderHash;
```

The EIP-712 hash of the signed order whose placement threw, for `reconcileOrder`. Set by
the orderbook client on errors from placing one order; `undefined` otherwise.

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

***

### requestId?

```ts
readonly optional requestId?: string;
```

***

### service

```ts
readonly service: Service;
```

***

### status?

```ts
readonly optional status?: number;
```

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

A log-safe plain object. Fields that are `undefined` are left out.

#### Returns

`Record`\<`string`, `unknown`\>
