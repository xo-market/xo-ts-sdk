# Type Alias: WaitForBridgePaymentOptions

```ts
type WaitForBridgePaymentOptions = object;
```

The options of [SecureClient.waitForBridgePayment](../interfaces/SecureClient.md#waitforbridgepayment): a signal that ends the wait, and how long to
wait in all. A wait is not retried: it reads the payment again until it is final.

## Properties

### signal?

```ts
signal?: AbortSignal;
```

Ends the wait: it rejects with a `RequestAbortedError` whose `cause` is the signal's reason.

***

### timeout?

```ts
timeout?: number;
```

How long to wait in all, in whole milliseconds, from 1 to 86 400 000 (24 hours). Defaults
to 3 600 000 (one hour).
