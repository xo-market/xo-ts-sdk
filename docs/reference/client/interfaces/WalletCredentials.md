# Interface: WalletCredentials

The credentials of a wallet: what [SecureClient.exportCredentials](SecureClient.md#exportcredentials) gives and the
`credentials` option of [createSecureClient](../functions/createSecureClient.md) takes, so an export can be passed to a new
client as it is. They are secrets: keep them out of logs.

## Properties

### backend?

```ts
optional backend?: object;
```

An API key of the wallet's account. `id` and `expiresAt` are the key's metadata, when known:
an export has them for a key the client signed in for or loaded, and none for a key it was
given without them.

#### apiKey

```ts
apiKey: string;
```

#### expiresAt?

```ts
optional expiresAt?: string;
```

#### id?

```ts
optional id?: string;
```

***

### orderbook?

```ts
optional orderbook?: object;
```

The wallet's own order book credentials: the ones signing in derives for it.

#### apiKey

```ts
apiKey: string;
```

#### passphrase

```ts
passphrase: string;
```

#### secret

```ts
secret: string;
```
