# Type Alias: OrderResponse

```ts
type OrderResponse = 
  | AcceptedOrderResponse
  | RejectedOrderResponse;
```

The result of placing an order: accepted or refused, told apart by `ok`.
