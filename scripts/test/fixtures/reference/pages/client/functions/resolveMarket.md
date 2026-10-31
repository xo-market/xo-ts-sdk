# Function: resolveMarket()

```ts
function resolveMarket(input, deps): Promise<ResolvedMarket>;
```

Resolves a market across the backend and the orderbook, and says whether it can be traded.

Its `marketId` is the backend's id of the [Market](../interfaces/Market.md#marketid).

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `input` | `string` \| `number` | A backend market id (a number or a numeric string), a slug, a condition id (`0x` and 64 hex digits, any case) or a contract address (`0x` and 40 hex digits). |
| `deps` | [`ResolveDeps`](../interfaces/ResolveDeps.md) | - |

## Returns

`Promise`\<[`ResolvedMarket`](../interfaces/ResolvedMarket.md)\>

## Throws

For input that is none of the above (before any request), or a
  non-binary market (code `not_binary`: the orderbook's outcomes must be exactly YES and NO).
