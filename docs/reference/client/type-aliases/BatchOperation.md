# Type Alias: BatchOperation

```ts
type BatchOperation = 
  | {
  orders: SignedOrder[];
  type: "place";
}
  | {
  orderIds: string[];
  type: "cancel";
};
```

One operation of [SecureClient.postOrderBatch](../interfaces/SecureClient.md#postorderbatch): signed orders to place, or ids of orders to cancel.

## Union Members

### Type Literal

```ts
{
  orders: SignedOrder[];
  type: "place";
}
```

#### orders

```ts
orders: SignedOrder[];
```

The orders, each signed by [SecureClient.createLimitOrder](../interfaces/SecureClient.md#createlimitorder) or [SecureClient.createMarketOrder](../interfaces/SecureClient.md#createmarketorder).

#### type

```ts
type: "place";
```

Place orders.

***

### Type Literal

```ts
{
  orderIds: string[];
  type: "cancel";
}
```

#### orderIds

```ts
orderIds: string[];
```

The ids of the orders: order hashes or numeric order ids.

#### type

```ts
type: "cancel";
```

Cancel orders.
