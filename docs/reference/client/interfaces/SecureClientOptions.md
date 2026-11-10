# Interface: SecureClientOptions

The options of [createSecureClient](../functions/createSecureClient.md). Only `signer` is required.

## Extends

- [`PublicClientOptions`](PublicClientOptions.md)

## Properties

### credentials?

```ts
credentials?: WalletCredentials;
```

Credentials this wallet already has, used instead of signing in for them: an API key
(`backend: { apiKey }`, with its `id` and `expiresAt` when you have them) and order book
credentials (`orderbook: { apiKey, secret, passphrase }`). What `exportCredentials()` gives
can be passed here as it is.

They are checked when the client is created, before they are used for anything: the API
key must be one of the wallet's account (one read of the account), and the order book
credentials must be the wallet's own default ones, the ones signing in derives for it and
`exportCredentials()` gives (one wallet signature). Anything else is refused with
`credentials_not_owned`.

The client never rotates them. `close()` leaves them active; `endAuthentication()` revokes
them.

***

### environment?

```ts
environment?: EnvironmentConfig;
```

Where the client reads: the hosts and contracts of an environment. Leave it out for XO
mainnet. Pass your own config only to point at another deployment, such as a local one.

#### Inherited from

[`PublicClientOptions`](PublicClientOptions.md).[`environment`](PublicClientOptions.md#environment)

***

### fetch?

```ts
fetch?: (input, init?) => Promise<Response>;
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

#### Inherited from

[`PublicClientOptions`](PublicClientOptions.md).[`fetch`](PublicClientOptions.md#fetch)

***

### label?

```ts
label?: string;
```

A name for the API keys this client signs in for, which they carry as
`xo-sdk:<label>:<yyyymmdd>`: 1 to 64 of `A-Z a-z 0-9 . _ -`. Defaults to `default`.

***

### onRateLimitUpdate?

```ts
onRateLimitUpdate?: (update) => void;
```

Called with the rate-limit information of every response that carries it, and of every 429.
An error it throws is ignored.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `update` | [`RateLimitUpdate`](RateLimitUpdate.md) |

#### Returns

`void`

#### Inherited from

[`PublicClientOptions`](PublicClientOptions.md).[`onRateLimitUpdate`](PublicClientOptions.md#onratelimitupdate)

***

### rail?

```ts
rail?: "sponsored" | "direct";
```

How transactions go on chain. Leave it out: XO's sponsor sends them and pays the gas.
`'direct'` sends a plain transaction that the signer pays gas for, one call at a time, and
works only when the client trades from the signer's own address.

***

### shutdownHooks?

```ts
shutdownHooks?: boolean;
```

Whether to revoke a 1-day API key when the process ends: on SIGINT or SIGTERM (then the
process ends as the signal asks) and when it exits normally. Defaults to `true`. It only
applies to a client that signs in for a 1-day key: no persistent `store`, and no
`credentials.backend`. Pass `false` to handle this yourself (call `close()`).

***

### signer

```ts
signer: Signer;
```

The wallet that signs: `privateKey(key)` or `signerFrom(account)` from
`@xomarket/client/viem`, or a signer of your own. Required.

***

### store?

```ts
store?: CredentialStore;
```

Where the client keeps the credentials it signs in for. Leave it out to keep them in
memory: the client then signs in for a 1-day API key and revokes it on `close()`, on
Ctrl-C (SIGINT), SIGTERM, and when the process exits normally. A persistent store, such as
`fileStore` from `@xomarket/client/node`, keeps one 90-day key across restarts instead.

***

### strictResponses?

```ts
strictResponses?: boolean;
```

Whether a response field the SDK does not know is an error (for contract tests).

***

### wallet?

```ts
wallet?: string;
```

The account that trades, as an address. Leave it out to trade from the signer's own
address. Any other address must be one of the signer's smart wallets (numbers 0 to 9:
[PublicClient.fetchSmartWalletAddress](PublicClient.md#fetchsmartwalletaddress) gives their addresses); an address the signer
does not own is refused before anything is signed or sent.

An undeployed smart wallet is deployed once, gas-free, when the client is created: XO's
sponsor sends the one transaction that [SecureClient.setupTradingApprovals](SecureClient.md#setuptradingapprovals) would
send, which makes the smart wallet and sets its approvals for trading, before the client
signs in. A smart wallet that exists already, or the signer's own address, is sent nothing.

***

### WebSocket?

```ts
WebSocket?: new (url, protocols?) => WebSocket;
```

The WebSocket constructor of the live channels. Defaults to the global `WebSocket`.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `url` | `string` \| `URL` |
| `protocols?` | `string` \| `string`[] \| `WebSocketInit` |

#### Returns

`WebSocket`

#### Inherited from

[`PublicClientOptions`](PublicClientOptions.md).[`WebSocket`](PublicClientOptions.md#websocket)
