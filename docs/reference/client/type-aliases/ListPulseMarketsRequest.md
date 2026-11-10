# Type Alias: ListPulseMarketsRequest

```ts
type ListPulseMarketsRequest = object;
```

What [PublicClient.listPulseMarkets](../interfaces/PublicClient.md#listpulsemarkets) takes. Every key is optional.

## Properties

### pageSize?

```ts
pageSize?: number;
```

How many rounds a page holds, from 1 to 100.

***

### status?

```ts
status?: "active" | "resolved" | "closed";
```

Only rounds in this stage: `active` (running), `resolved` or `closed`.
