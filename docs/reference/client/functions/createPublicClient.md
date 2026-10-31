# Function: createPublicClient()

```ts
function createPublicClient(options?): PublicClient;
```

Creates a client that reads public data. It is synchronous and sends no request: the first
request is the first read you make. It holds no credential, and its reads send none.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`PublicClientOptions`](../interfaces/PublicClientOptions.md) | Where to read (`environment`, XO mainnet by default), the `fetch` and `WebSocket` to use, and a callback for rate-limit updates. Retries, timeouts and cancelling belong to each call, not to the client. |

## Returns

[`PublicClient`](../interfaces/PublicClient.md)

## Throws

For a key that is not an option, or an option of the wrong type or
  an invalid environment, before anything is requested. The message never repeats a value.

## Example

```ts
const client = createPublicClient();
const midpoint = await client.fetchMidpoint({ assetId });
```
