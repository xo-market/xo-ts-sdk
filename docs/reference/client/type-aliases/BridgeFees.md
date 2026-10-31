# Type Alias: BridgeFees

```ts
type BridgeFees = object;
```

What a payment costs, in `currency`. A fee the bridge states in a form that is not a plain decimal is `null`.

## Properties

### business

```ts
business: DecimalString | null;
```

The business fee.

***

### conversion

```ts
conversion: DecimalString | null;
```

The fee for converting between assets.

***

### currency

```ts
currency: string;
```

The currency the fees are in, such as `USD`.

***

### network

```ts
network: DecimalString | null;
```

The network (gas) fee.

***

### total

```ts
total: DecimalString | null;
```

All the fees together.
