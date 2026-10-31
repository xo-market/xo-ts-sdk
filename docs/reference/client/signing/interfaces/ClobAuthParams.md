# Interface: ClobAuthParams

What an L1 (ClobAuth) signature covers: see [clobAuthTypedData](../functions/clobAuthTypedData.md).

## Properties

### address

```ts
address: `0x${string}`;
```

The wallet that signs. Any case: it is checksummed.

***

### chainId

```ts
chainId: number;
```

The chain id of the ClobAuth domain.

***

### nonce

```ts
nonce: bigint;
```

The L1 nonce, a `bigint` in `[0, 2^256)`.

***

### timestamp

```ts
timestamp: string;
```

Unix seconds as a decimal string. The gateway allows a skew of 120 seconds.
