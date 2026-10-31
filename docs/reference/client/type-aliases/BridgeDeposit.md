# Type Alias: BridgeDeposit

```ts
type BridgeDeposit = object;
```

Where to send the money of a confirmed payment, and how much: send exactly `amount` of the
asset `assetId` on `chain` to `address`, once, before the payment's `fundBy`.

## Properties

### address

```ts
address: string;
```

The one-time address for this payment, on `chain`. Send to it once.

***

### amount

```ts
amount: DecimalString;
```

How much to send, in whole units of the asset (`"25.5"` is 25.5 tokens). Send exactly this much.

***

### assetId

```ts
assetId: string;
```

The asset to send, as an asset id (`network:address`), not a symbol.

***

### chain

```ts
chain: string;
```

The network to send on, such as `base`.
