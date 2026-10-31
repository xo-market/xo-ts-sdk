# Type Alias: FetchEventRequest

```ts
type FetchEventRequest = 
  | {
  id: string;
}
  | {
  slug: string;
};
```

What [PublicClient.fetchEvent](../interfaces/PublicClient.md#fetchevent) takes: `id` (the event's id, a UUID) or `slug` (its URL name).
