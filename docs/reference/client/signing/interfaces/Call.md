# Interface: Call

One on-chain call: sent as it is from an EOA, or made by a smart wallet through its `execute`.

## Properties

### data

```ts
data: `0x${string}`;
```

The calldata, as even-length `0x` hex. `0x` for a plain transfer.

***

### to

```ts
to: `0x${string}`;
```

The target. Any case: it is checksummed.

***

### value?

```ts
optional value?: bigint;
```

Wei to send. Defaults to 0.
