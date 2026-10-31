# Variable: CANCEL\_ORDER\_TYPES

```ts
const CANCEL_ORDER_TYPES: object;
```

The EIP-712 types of a signed single-order cancel: `CancelOrder(uint64 orderId,string marketId)`.

## Type Declaration

### CancelOrder

```ts
readonly CancelOrder: readonly [{
  name: "orderId";
  type: "uint64";
}, {
  name: "marketId";
  type: "string";
}];
```
