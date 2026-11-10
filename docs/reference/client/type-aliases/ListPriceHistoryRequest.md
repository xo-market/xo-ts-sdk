# Type Alias: ListPriceHistoryRequest

```ts
type ListPriceHistoryRequest = object;
```

What [PublicClient.listPriceHistory](../interfaces/PublicClient.md#listpricehistory) takes.

## Properties

### assetId

```ts
assetId: string;
```

The outcome token whose prices to read: a decimal string of digits.

***

### endTs?

```ts
endTs?: number;
```

Only points at or before this time, in Unix seconds.

***

### fidelity?

```ts
fidelity?: number;
```

How many of the newest points to read from the order book, from 1 to 500. The order book
returns 100 when this is left out.

***

### interval

```ts
interval: "1h" | "6h" | "1d" | "1w" | "max";
```

How far back to read, ending at `endTs` (now when it is left out): `1h`, `6h`, `1d`, `1w`
or `max` for as far back as the points reach.

***

### startTs?

```ts
startTs?: number;
```

Only points at or after this time, in Unix seconds.
