# Function: isSecureClient()

```ts
function isSecureClient(value): value is SecureClient;
```

Whether `value` is a client made by `createSecureClient`: a client that signed in with a
wallet. A client made by `createPublicClient` is not. Only a client of the same build of
this package is recognised: one made by its CommonJS build is not, to code that imports its
ES module, and the reverse.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

## Returns

`value is SecureClient`

## Example

```ts
const client: unknown = await createSecureClient({ signer });
if (isSecureClient(client)) {
  console.log(client.wallet);
}
```
