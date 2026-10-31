# Type Alias: BatchOperationResult

```ts
type BatchOperationResult = 
  | {
  orders: OrderResponse[];
  type: "place";
}
  | object & CancelOrdersResponse;
```

What one operation of [SecureClient.postOrderBatch](../interfaces/SecureClient.md#postorderbatch) did, in the order of the operations.

## Union Members

### Type Literal

```ts
{
  orders: OrderResponse[];
  type: "place";
}
```

#### orders

```ts
orders: OrderResponse[];
```

The result of each order, in the order given.

#### type

```ts
type: "place";
```

Orders placed.

***

`object` & [`CancelOrdersResponse`](CancelOrdersResponse.md)
