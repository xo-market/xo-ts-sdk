# Interface: OrderStruct

An order as the exchange hashes it. Integers are `bigint`; `side` 0 is BUY and 1 is SELL.

## Properties

### beneficiary

```ts
beneficiary: `0x${string}`;
```

***

### expiration

```ts
expiration: bigint;
```

uint256

***

### identifier

```ts
identifier: `0x${string}`;
```

bytes16, as 0x plus 32 hex characters.

***

### maker

```ts
maker: `0x${string}`;
```

***

### makerAmount

```ts
makerAmount: bigint;
```

uint256

***

### metadata

```ts
metadata: `0x${string}`;
```

bytes32, as 0x plus 64 hex characters.

***

### nonce

```ts
nonce: bigint;
```

uint128

***

### salt

```ts
salt: bigint;
```

uint256

***

### side

```ts
side: 0 | 1;
```

0 is BUY, 1 is SELL.

***

### signatureType

```ts
signatureType: 0 | 3;
```

0 is an EOA signature, 3 is a smart wallet.

***

### signer

```ts
signer: `0x${string}`;
```

***

### takerAmount

```ts
takerAmount: bigint;
```

uint256

***

### tokenId

```ts
tokenId: bigint;
```

uint256
