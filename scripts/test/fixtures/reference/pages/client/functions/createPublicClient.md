# Function: createPublicClient()

```ts
function createPublicClient(options?): PublicClient;
```

Creates a client that reads public data. It is synchronous and sends no request: the first
request is the first read you make. It holds no credential, and its reads send none.

- The environment is XO mainnet unless `environment` names another config.
- Retries, timeouts and cancelling belong to each call, not to the client.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `options?` | `PublicClientOptions` |

## Returns

`PublicClient`

## Throws

ValidationError for an unknown or invalid option, before anything is requested. No message holds a value.
