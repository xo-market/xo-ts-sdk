# Type Alias: FetchSeriesRequest

```ts
type FetchSeriesRequest = 
  | {
  id: string;
}
  | {
  slug: string;
};
```

What [PublicClient.fetchSeries](../interfaces/PublicClient.md#fetchseries) takes: `id` (the series' id, a UUID) or `slug` (its URL name).
