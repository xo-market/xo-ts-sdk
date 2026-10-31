# Function: orderTypedData()

```ts
function orderTypedData(order, domain): MessageDefinition<{
  Order: readonly [{
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
}, "Order">;
```

The typed data to sign for an order. Addresses (including the domain's
`verifyingContract`) are checksummed, so the result does not depend on their input case.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `order` | [`OrderStruct`](../../interfaces/OrderStruct.md) |
| `domain` | `TypedDataDomain` |

## Returns

`MessageDefinition`\<\{
  `Order`: readonly \[\{
     `name`: `"salt"`;
     `type`: `"uint256"`;
   \}, \{
     `name`: `"maker"`;
     `type`: `"address"`;
   \}, \{
     `name`: `"signer"`;
     `type`: `"address"`;
   \}, \{
     `name`: `"beneficiary"`;
     `type`: `"address"`;
   \}, \{
     `name`: `"tokenId"`;
     `type`: `"uint256"`;
   \}, \{
     `name`: `"makerAmount"`;
     `type`: `"uint256"`;
   \}, \{
     `name`: `"takerAmount"`;
     `type`: `"uint256"`;
   \}, \{
     `name`: `"expiration"`;
     `type`: `"uint256"`;
   \}, \{
     `name`: `"nonce"`;
     `type`: `"uint128"`;
   \}, \{
     `name`: `"identifier"`;
     `type`: `"bytes16"`;
   \}, \{
     `name`: `"metadata"`;
     `type`: `"bytes32"`;
   \}, \{
     `name`: `"side"`;
     `type`: `"uint8"`;
   \}, \{
     `name`: `"signatureType"`;
     `type`: `"uint8"`;
  \}\];
\}, `"Order"`\>

## Throws

UserInputError, starting with the field name, for the first field that is missing, out of range or malformed. The domain is checked first, then the order in struct order.
