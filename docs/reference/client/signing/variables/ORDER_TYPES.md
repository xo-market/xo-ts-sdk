# Variable: ORDER\_TYPES

```ts
const ORDER_TYPES: object;
```

The EIP-712 types of an exchange order. The field order is part of the type hash, and
the signed string is exactly
`Order(uint256 salt,address maker,address signer,address beneficiary,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint128 nonce,bytes16 identifier,bytes32 metadata,uint8 side,uint8 signatureType)`.
There is no `EIP712Domain` entry; viem derives it from the domain.

## Type Declaration

### Order

```ts
readonly Order: readonly [{
  name: "salt";
  type: "uint256";
}, {
  name: "maker";
  type: "address";
}, {
  name: "signer";
  type: "address";
}, {
  name: "beneficiary";
  type: "address";
}, {
  name: "tokenId";
  type: "uint256";
}, {
  name: "makerAmount";
  type: "uint256";
}, {
  name: "takerAmount";
  type: "uint256";
}, {
  name: "expiration";
  type: "uint256";
}, {
  name: "nonce";
  type: "uint128";
}, {
  name: "identifier";
  type: "bytes16";
}, {
  name: "metadata";
  type: "bytes32";
}, {
  name: "side";
  type: "uint8";
}, {
  name: "signatureType";
  type: "uint8";
}];
```
