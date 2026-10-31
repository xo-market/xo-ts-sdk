# Type Alias: ConvictionOutcome

```ts
type ConvictionOutcome = object;
```

One outcome of a conviction market.

## Properties

### price

```ts
price: DecimalString | null;
```

The outcome's price: the midpoint, else the last trade. `null` when it has neither.

***

### tokenId

```ts
tokenId: TokenId;
```

The outcome's token, the id to read its book with.
