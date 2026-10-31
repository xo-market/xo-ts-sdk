# Function: cancelAllTypedData()

```ts
function cancelAllTypedData(marketId, domain): MessageDefinition<{
  CancelAll: readonly [{
     name: "marketId";
     type: "string";
  }];
}, "CancelAll">;
```

The typed data to sign to cancel every open order in a market. An empty `marketId`
means a global cancel-all. It is signed under the same domain as orders.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `marketId` | `string` |
| `domain` | `TypedDataDomain` |

## Returns

`MessageDefinition`\<\{
  `CancelAll`: readonly \[\{
     `name`: `"marketId"`;
     `type`: `"string"`;
  \}\];
\}, `"CancelAll"`\>

## Throws

UserInputError if `marketId` is not a string or the domain is incomplete or malformed (see `orderDomain`).
