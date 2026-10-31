# Type Alias: UserOrderEventKind

```ts
type UserOrderEventKind = "PLACEMENT" | "UPDATE" | "CANCELLATION" | "REJECTED" | string & object;
```

What happened to an order, in an [UserOrderEvent](UserOrderEvent.md):

- `PLACEMENT`: the order rests on the book.
- `UPDATE`: some of it filled (`status: 'MATCHED'` once all of it has).
- `CANCELLATION`: it was cancelled: by you, by a mass cancel, by its expiry or by the market
  closing.
- `REJECTED`: it was refused before it rested, so it has no id.

A kind added later reads as its own string.
