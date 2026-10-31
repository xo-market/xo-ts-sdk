# Interface: PublicClientOptions

The options of [createPublicClient](../functions/createPublicClient.md). Every one is optional.

## Extended by

- [`SecureClientOptions`](SecureClientOptions.md)

## Properties

### environment?

```ts
optional environment?: EnvironmentConfig;
```

Where the client reads: the hosts and contracts of an environment. Leave it out for XO
mainnet. Pass your own config only to point at another deployment, such as a local one.

***

### fetch?

```ts
optional fetch?: (input, init?) => Promise<Response>;
```

The `fetch` of every request. Defaults to the global one. The reads of the chain use the
global `fetch` regardless.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `input` | `string` \| `URL` \| `Request` |
| `init?` | `RequestInit` |

#### Returns

`Promise`\<`Response`\>

***

### onRateLimitUpdate?

```ts
optional onRateLimitUpdate?: (update) => void;
```

Called with the rate-limit information of every response that carries it, and of every 429.
An error it throws is ignored.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `update` | [`RateLimitUpdate`](RateLimitUpdate.md) |

#### Returns

`void`

***

### WebSocket?

```ts
optional WebSocket?: (url, protocols?) => WebSocket;
```

The WebSocket constructor of the live channels. Defaults to the global `WebSocket`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `url` | `string` \| `URL` |
| `protocols?` | `string` \| `string`[] \| `WebSocketInit` |

#### Returns

`WebSocket`
