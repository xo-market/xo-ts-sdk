# Type Alias: BridgeAsset

```ts
type BridgeAsset = object;
```

A token a deposit can be paid in, or a withdrawal can be sent as.

## Properties

### address

```ts
address: string;
```

The token's address on its network.

***

### addressFamily

```ts
addressFamily: string;
```

The address family of the network, such as `EVM` or `SOLANA`.

***

### assetId

```ts
assetId: string;
```

The asset id, `network:address`. Pass it back as the asset of a quote.

***

### chain

```ts
chain: string;
```

The network's name, such as `base` or `ethereum`.

***

### chainId

```ts
chainId: string | null;
```

The network's EVM chain id as a decimal string (`"8453"` for Base), or `null` for a
network of another address family. It is text because some chain ids do not fit a
JavaScript number.

***

### decimals

```ts
decimals: number;
```

The token's decimals (6 for USDC).

***

### image

```ts
image: string | null;
```

The token's logo.

***

### isNative

```ts
isNative: boolean;
```

Whether the token is the network's own coin.

***

### name

```ts
name: string;
```

The token's name, such as `USD Coin`.

***

### symbol

```ts
symbol: string;
```

The token's symbol, such as `USDC`.
