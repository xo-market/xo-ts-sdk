# Type Alias: MergePositionsRequest

```ts
type MergePositionsRequest = object;
```

What [SecureClient.mergePositions](../interfaces/SecureClient.md#mergepositions) takes.

## Properties

### amount?

```ts
amount?: string | number;
```

How many full sets to merge, in whole shares (`'5'` merges 5 YES and 5 NO for 5 USDC), with
at most 6 decimals. Leave it out to merge all that is free of both outcomes.

***

### conditionId

```ts
conditionId: string;
```

The market's condition id, `0x` and 64 hex digits.
