# Type Alias: ListPositionsRequest

```ts
type ListPositionsRequest = object;
```

What [PublicClient.listPositions](../interfaces/PublicClient.md#listpositions) takes on a client without a wallet.

## Properties

### market?

```ts
market?: string;
```

Only the positions of this market: its condition id, `0x` and 64 hex digits.

***

### redeemable?

```ts
redeemable?: boolean;
```

`true` lists only the positions the SDK can redeem now (`Position.redeemable`): their
market of the order book is resolved or voided, and the winnings are not claimed. `false`
lists only the others.

***

### user

```ts
user: string;
```

The wallet whose positions to list: `0x` and 40 hex digits.
