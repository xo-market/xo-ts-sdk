# Function: toWireOrder()

```ts
function toWireOrder(order, signature): WireOrder;
```

The body fields the gateway takes for an order: integers as decimal strings, `side` as
`'BUY'` or `'SELL'`, addresses checksummed. `signature` is passed through unchanged, but
it must be non-empty, even-length `0x` hex, and exactly 65 bytes for an EOA order
(`signatureType` 0), which is what the gateway enforces. Only these 14 fields are
emitted, whatever else the order object carries.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `order` | [`OrderStruct`](../../interfaces/OrderStruct.md) |
| `signature` | `` `0x${string}` `` |

## Returns

[`WireOrder`](../../interfaces/WireOrder.md)

## Throws

UserInputError, starting with the field name, for the first field (in struct order, then the signature) that is missing, out of range or malformed.
