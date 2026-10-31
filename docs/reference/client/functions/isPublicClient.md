# Function: isPublicClient()

```ts
function isPublicClient(value): value is PublicClient;
```

Whether `value` is a client made by `createPublicClient`: a client that reads public data
only. A client that signed in is not a public client; see [isSecureClient](isSecureClient.md). Only a
client of the same build of this package is recognised: one made by its CommonJS build is
not, to code that imports its ES module, and the reverse.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `value` | `unknown` |

## Returns

`value is PublicClient`

## Example

```ts
const client: unknown = createPublicClient();
if (isPublicClient(client)) {
  console.log(await client.fetchTradingState());
}
```
