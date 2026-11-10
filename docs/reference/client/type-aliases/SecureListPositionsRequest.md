# Type Alias: SecureListPositionsRequest

```ts
type SecureListPositionsRequest = object;
```

What `listPositions` takes on a signed-in client: the same as [ListPositionsRequest](ListPositionsRequest.md),
and the wallet is the client's own when `user` is left out.

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

### user?

```ts
user?: string;
```

The wallet whose positions to list. Leave it out for the client's own wallet.
