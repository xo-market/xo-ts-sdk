# Interface: XoAuth

`xo.auth`: the session's credentials. Every authenticated call logs in by itself when needed.

## Methods

### credentials()

```ts
credentials(): Promise<StoredCredentials>;
```

The credentials the client uses, logging in for any it does not hold yet: the same set as
[XoAuth.login](#login). They are secrets: keep them in a store of your own, or pass them as
`credentials` to another client. A key you brought has only `key` set.

#### Returns

`Promise`\<`StoredCredentials`\>

#### Throws

AuthRequiredError when the client has neither a signer nor credentials.

***

### login()

```ts
login(): Promise<void>;
```

Logs in now instead of on the first authenticated call: every credential the client can
hold (the backend key, then the orderbook credentials, with a signer; the ones you brought,
without).

#### Returns

`Promise`\<`void`\>

#### Throws

AuthRequiredError when the client has neither a signer nor credentials.

***

### rotate()

```ts
rotate(): Promise<void>;
```

Replaces the backend key now: mint, switch, store, then revoke the old key.

#### Returns

`Promise`\<`void`\>

#### Throws

XoError `credentials_provided` for a key from `credentials.backend`, which the SDK never rotates.

#### Throws

AuthRequiredError without a signer.

***

### tradingAddress()

```ts
tradingAddress(): Promise<`0x${string}`>;
```

The address that trades and holds the funds: the signer's for `{ type: 'eoa' }`, the
smart wallet's for `{ type: 'smart_wallet' }`.

#### Returns

`Promise`\<`` `0x${string}` ``\>

#### Throws

AuthRequiredError without a signer.
