# Interface: ExecutorSignature

The executor's secp256k1 signature over `executorSigningHash`, decomposed for
the signed envelope. `yParity` is `0 | 1` (NOT the `27/28` `v`).

## Properties

### r

```ts
r: `0x${string}`;
```

***

### s

```ts
s: `0x${string}`;
```

***

### yParity

```ts
yParity: 0 | 1;
```
