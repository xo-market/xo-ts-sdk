# Function: privateKey()

```ts
function privateKey(key): Signer;
```

A signer for a private key. The key stays in a closure.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `key` | `string` | The key: `0x` and 32 bytes of hex. Any string is accepted at compile time (an environment variable is a `string`, not a `Hex`) and checked here. |

## Returns

[`Signer`](../../interfaces/Signer.md)

A frozen signer that can also sign a raw hash.

## Throws

`invalid_private_key` if `key` is not 32 bytes of hex or is not a
  valid secp256k1 key. The message starts with `privateKey` and never contains the key.

## Example

```ts
const signer = privateKey(process.env.XO_PK as string);
console.log(await signer.getAddress());
```
