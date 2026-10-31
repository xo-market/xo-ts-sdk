# Type Alias: BridgePaymentStatus

```ts
type BridgePaymentStatus = 
  | "QUOTED"
  | "CONFIRM_UNKNOWN"
  | "NEEDS_VERIFICATION"
  | "AWAITING_FUNDS"
  | "PROCESSING"
  | "COMPLETE"
  | "HALTED"
  | "EXPIRED"
  | "TAINTED"
  | string & object;
```

Where a payment is in its life. A status added later reads as its own string. The statuses
that end it are `COMPLETE`, `EXPIRED` and `TAINTED`; `HALTED` is not final.

- `QUOTED`: a quote nobody confirmed.
- `CONFIRM_UNKNOWN`: confirming the quote timed out or failed with a server error, so the
  outcome is unknown. Read the payment again, and do not confirm again.
- `NEEDS_VERIFICATION`: the bridge asks the owner wallet to sign first.
- `AWAITING_FUNDS`: confirmed, waiting for the money (see [BridgePayment.deposit](BridgePayment.md#deposit)).
- `PROCESSING`: the bridge has the money and is delivering.
- `COMPLETE`: delivered. Final.
- `HALTED`: stopped, but it may still finish or need recovery (see
  [BridgePayment.recoveryUrl](BridgePayment.md#recoveryurl)). Not final.
- `EXPIRED`: not funded in time. Final.
- `TAINTED`: the bridge will not complete the payment. Final.
