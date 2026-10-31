# Function: estimateIntrinsicGas()

```ts
function estimateIntrinsicGas(calls): bigint;
```

Client-side intrinsic-gas floor.
Advisory only — the node computes the authoritative figure — but a useful
lower bound when no on-chain estimate is available.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `calls` | [`EvCall`](../interfaces/EvCall.md)[] |

## Returns

`bigint`
