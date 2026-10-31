# Function: hashOrder()

```ts
function hashOrder(order, domain): OrderHash;
```

The EIP-712 digest of an order, the same value the deployed exchange's `hashOrder`
returns.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `order` | [`OrderStruct`](../../interfaces/OrderStruct.md) |
| `domain` | `TypedDataDomain` |

## Returns

[`OrderHash`](../../type-aliases/OrderHash.md)

## Throws

UserInputError, starting with the field name, for the first field that is missing, out of range or malformed. The domain is checked first, then the order in struct order.
