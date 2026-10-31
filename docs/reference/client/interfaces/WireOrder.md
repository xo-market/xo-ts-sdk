# Interface: WireOrder

An order as the gateway takes it: integers as decimal strings, `side` as a word.

## Properties

### beneficiary

```ts
beneficiary: `0x${string}`;
```

***

### expiration

```ts
expiration: string;
```

***

### identifier

```ts
identifier: `0x${string}`;
```

***

### maker

```ts
maker: `0x${string}`;
```

***

### makerAmount

```ts
makerAmount: string;
```

***

### metadata

```ts
metadata: `0x${string}`;
```

***

### nonce

```ts
nonce: string;
```

***

### salt

```ts
salt: string;
```

***

### side

```ts
side: "BUY" | "SELL";
```

***

### signature

```ts
signature: `0x${string}`;
```

***

### signatureType

```ts
signatureType: 0 | 3;
```

***

### signer

```ts
signer: `0x${string}`;
```

***

### takerAmount

```ts
takerAmount: string;
```

***

### tokenId

```ts
tokenId: string;
```
