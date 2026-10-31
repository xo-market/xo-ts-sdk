# Variable: KERNEL\_TYPES

```ts
const KERNEL_TYPES: object;
```

The EIP-712 types of the Kernel ERC-1271 wrap: `Kernel(bytes32 hash)`. There is no
`EIP712Domain` entry; viem derives it from the domain.

## Type Declaration

### Kernel

```ts
readonly Kernel: readonly [{
  name: "hash";
  type: "bytes32";
}];
```
