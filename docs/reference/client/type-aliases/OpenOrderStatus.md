# Type Alias: OpenOrderStatus

```ts
type OpenOrderStatus = "LIVE" | "MATCHED" | string & object;
```

Where an open order is, in XO's words. A status added later reads as its own string.

- `LIVE`: nothing has filled yet.
- `MATCHED`: some of it has filled (see [OpenOrder.sizeMatched](OpenOrder.md#sizematched)).
