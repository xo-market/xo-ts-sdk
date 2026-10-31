# Type Alias: MarketResolution

```ts
type MarketResolution = object;
```

How a market is resolved, and what it resolved to.

## Properties

### evidence

```ts
evidence: string | null;
```

The evidence the resolver gave, if any.

***

### resolutionType

```ts
resolutionType: "AUTOMATIC" | "MANUAL" | "ORACLE" | string & object | null;
```

How the market resolves: `AUTOMATIC`, `MANUAL` or `ORACLE`.

***

### resolvedAt

```ts
resolvedAt: string | null;
```

When the market resolved, as an ISO 8601 time.

***

### resolvedBy

```ts
resolvedBy: Address | null;
```

The address that resolves the market.

***

### sources

```ts
sources: string[];
```

The pages the resolution is based on.

***

### winningOutcome

```ts
winningOutcome: "yes" | "no" | null;
```

The side that won, once the market has resolved. `null` while it is open or when it was voided.
