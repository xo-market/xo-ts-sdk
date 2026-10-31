# Function: orderDomain()

```ts
function orderDomain(chainId, exchange): TypedDataDomain;
```

The EIP-712 domain of the exchange: name `XO Market CLOB`, version `1`. The same domain
signs orders and cancels. `exchange` is checksummed, so any address case is accepted.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `chainId` | `number` |
| `exchange` | `` `0x${string}` `` |

## Returns

`TypedDataDomain`

## Throws

UserInputError if `chainId` is not a positive safe integer or `exchange` is not a 20-byte hex address.
