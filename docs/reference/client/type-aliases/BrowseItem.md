# Type Alias: BrowseItem

```ts
type BrowseItem = 
  | {
  kind: "market";
  market: Market;
}
  | {
  event: BrowseEvent;
  kind: "event";
};
```

One card of the browse feed: a market that stands alone (`kind: 'market'`) or an event with
its markets (`kind: 'event'`).
