# Function: cancelOrderTypedData()

```ts
function cancelOrderTypedData(
   orderId, 
   marketId, 
   domain
): MessageDefinition<{
  CancelOrder: readonly [{
     name: "orderId";
     type: "uint64";
   }, {
     name: "marketId";
     type: "string";
  }];
}, "CancelOrder">;
```

The typed data to sign to cancel one order. It is signed under the same domain as
orders (see `orderDomain`).

`marketId` may be `''`: the gateway does not forbid it, so it is not rejected here.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `orderId` | `bigint` |
| `marketId` | `string` |
| `domain` | `TypedDataDomain` |

## Returns

`MessageDefinition`\<\{
  `CancelOrder`: readonly \[\{
     `name`: `"orderId"`;
     `type`: `"uint64"`;
   \}, \{
     `name`: `"marketId"`;
     `type`: `"string"`;
  \}\];
\}, `"CancelOrder"`\>

## Throws

UserInputError if `orderId` is not a bigint in `[0, 2^64)`, `marketId` is not a string, or the domain is incomplete or malformed (see `orderDomain`).
