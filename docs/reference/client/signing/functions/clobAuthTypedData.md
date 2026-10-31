# Function: clobAuthTypedData()

```ts
function clobAuthTypedData(p): MessageDefinition<{
  ClobAuth: readonly [{
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
}, "ClobAuth">;
```

The typed data to sign for L1 auth. The signature proves control of the wallet and is
used to create or derive the L2 credentials.

The domain is `{ name: 'ClobAuthDomain', version: '1', chainId }` and has no
`verifyingContract`: the gateway hashes `EIP712Domain(string name,string version,uint256 chainId)`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `p` | [`ClobAuthParams`](../interfaces/ClobAuthParams.md) |

## Returns

`MessageDefinition`\<\{
  `ClobAuth`: readonly \[\{
     `name`: `"address"`;
     `type`: `"address"`;
   \}, \{
     `name`: `"timestamp"`;
     `type`: `"string"`;
   \}, \{
     `name`: `"nonce"`;
     `type`: `"uint256"`;
   \}, \{
     `name`: `"message"`;
     `type`: `"string"`;
  \}\];
\}, `"ClobAuth"`\>

## Throws

UserInputError if `address` is not a 20-byte hex address, `timestamp` is not a string of decimal digits, `nonce` is not a bigint in `[0, 2^256)` or `chainId` is not a positive safe integer.
