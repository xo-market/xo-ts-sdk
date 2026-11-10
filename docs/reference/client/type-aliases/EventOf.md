# Type Alias: EventOf\<S\>

```ts
type EventOf<S> = S extends object ? MarketTopicEvent : S extends object ? UserEvent : S extends object ? PortfolioEvent : S extends object ? ActivityEvent : never;
```

The events a spec (or a union of specs) delivers.

## Type Parameters

| Type Parameter |
| ------ |
| <a id="type-parameter-s"></a> `S` |
