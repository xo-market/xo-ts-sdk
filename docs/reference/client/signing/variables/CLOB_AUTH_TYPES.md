# Variable: CLOB\_AUTH\_TYPES

```ts
const CLOB_AUTH_TYPES: object;
```

The EIP-712 types of an L1 auth signature: `ClobAuth(address address,string timestamp,uint256 nonce,string message)`.

## Type Declaration

### ClobAuth

```ts
readonly ClobAuth: readonly [{
  name: "address";
  type: "address";
}, {
  name: "timestamp";
  type: "string";
}, {
  name: "nonce";
  type: "uint256";
}, {
  name: "message";
  type: "string";
}];
```
