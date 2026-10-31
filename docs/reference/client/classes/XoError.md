# Class: XoError

The base class of every error the SDK throws.

`message`, `code` and `requestId` are run through the SDK's redaction, so an API key
that a server echoes back never ends up on the error. `toJSON()` redacts everything.
The raw response body is never stored.

## Extends

- `Error`

## Extended by

- [`AuthRequiredError`](AuthRequiredError.md)
- [`PaginationLimitError`](PaginationLimitError.md)
- [`RateLimitError`](RateLimitError.md)
- [`RequestAbortedError`](RequestAbortedError.md)
- [`RequestRejectedError`](RequestRejectedError.md)
- [`SigningError`](SigningError.md)
- [`TimeoutError`](TimeoutError.md)
- [`TransactionFailedError`](TransactionFailedError.md)
- [`TransportError`](TransportError.md)
- [`UnexpectedResponseError`](UnexpectedResponseError.md)
- [`UserInputError`](UserInputError.md)
- [`BatchOpsIncompleteError`](BatchOpsIncompleteError.md)
- [`BatchPlaceIncompleteError`](BatchPlaceIncompleteError.md)
- [`PlacementError`](PlacementError.md)

## Constructors

### Constructor

```ts
new XoError(message, opts?): XoError;
```

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `message` | `string` |
| `opts` | [`XoErrorOptions`](../interfaces/XoErrorOptions.md) |

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
error from sending a signed order, on an error of a cancel request, on a
[TransactionFailedError](TransactionFailedError.md), and on every error of a deposit or a withdrawal (a read or a
check made before a request is `false`). When it is true, never resend or re-sign: reconcile
first (for an order, `reconcileOrder({ orderHash: error.orderHash })`; for a cancel, read
the open orders with `listOpenOrders()`). `undefined` on every other error.

***

### orderHash?

```ts
readonly optional orderHash?: OrderHash;
```

The EIP-712 hash of the signed order whose placement threw, for `reconcileOrder`. Set on
the errors of placing or posting one order; `undefined` otherwise.

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

***

### topic?

```ts
readonly optional topic?: "market" | "user" | "portfolio" | "activity";
```

The topic an error of a live subscription is about: `'market'`, `'user'`, `'portfolio'` or
`'activity'`. Set on the errors a subscription handle reports, so you know whose state to
read again; `undefined` on `subscription_overflow`, which is about the whole handle, and on
every other error.

## Methods

### toJSON()

```ts
toJSON(): Record<string, unknown>;
```

A log-safe plain object. Fields that are `undefined` are left out.

#### Returns

`Record`\<`string`, `unknown`\>
