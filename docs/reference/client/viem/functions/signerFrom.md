# Function: signerFrom()

```ts
function signerFrom(source): Signer;
```

A signer for a viem local account (`privateKeyToAccount`, a mnemonic account, `toAccount`)
or a viem wallet client such as a browser wallet or a hardware wallet.

An account can sign a raw hash when it has `sign`, so then the signer has `signHash`. A
wallet client has no `signHash`: a wallet does not sign raw digests. A wallet client needs
an `account`, which is read once here and passed explicitly to every sign call.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `source` | \| \{ \} \| \{ \} | A viem local account, or a wallet client created with an `account`. |

## Returns

[`Signer`](../../interfaces/Signer.md)

A frozen signer.

## Throws

If `source` is neither a local account with an address,
  `signMessage` and `signTypedData`, nor a wallet client with an `account`.

## Example

```ts
const signer = signerFrom(privateKeyToAccount(process.env.XO_PK as Hex));
console.log(await signer.getAddress());
```
