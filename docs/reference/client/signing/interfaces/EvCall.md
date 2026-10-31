# Interface: EvCall

A single call inside an EvNode batch. `to = null` denotes a contract
creation (only valid as the first call).

## Properties

### input

```ts
input: `0x${string}`;
```

Calldata (or init code for a creation).

***

### to

```ts
to: `0x${string}` | null;
```

***

### value

```ts
value: bigint;
```
