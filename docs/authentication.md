# Wallets and sign-in

Your server signs in to XO with the wallet key of the account it trades.

## Sign-in happens when you create the client

`createSecureClient` resolves once the client has signed in. Your key signs once for an API key
for XO's account data, and once more for the order book's trading credentials. The first sign-in
also creates the XO account. There is no separate `login()` call.

<!-- snippet: docs/snippets/authentication.ts#credentials -->
```ts
console.log(`Trading as ${client.wallet}`);
console.log(JSON.stringify(client));
const credentials = await client.exportCredentials();
```

`JSON.stringify(client)` is safe to log: it shows the wallet and which credentials the client
holds, never their values. What `exportCredentials()` returns is secret: never log it.

## Your signer

`signer` is required. Make it with `privateKey` from `@xomarket/client/viem`, as the examples do,
or with `signerFrom` from a viem account, such as one that a key management service signs for:

<!-- snippet: docs/snippets/authentication.ts#signer-from-account -->
```ts
const client = await createSecureClient({ signer: signerFrom(account) });
```

A viem wallet client can sign in and trade, but cannot send on-chain transactions such as
`setupTradingApprovals`, since it cannot sign a raw digest (`sign_hash_unsupported`). You can also
write a `Signer` of your own: `getAddress`, `signMessage` and `signTypedData`, and `signHash` for
on-chain sends.

## Your trading address

`client.wallet` is the address that holds the funds and trades. By default it is your key's own
address, a plain wallet. To trade through a smart wallet that your key owns, pass its address as
`wallet`. `fetchSmartWalletAddress({ owner, index })` reads it from the chain, before the wallet
exists: see [Smart wallets](smart-wallets.md). An address the signer does not own is refused
before anything is signed or sent (`wallet_not_owned`).

## Keep credentials across restarts

By default the client keeps its credentials in memory, so every start signs in for a new 1-day
API key. On a server, use `fileStore` from `@xomarket/client/node`. It keeps one 90-day key
across restarts and rotates it before it expires.

<!-- snippet: docs/snippets/authentication.ts#file-store -->
```ts
const client = await createSecureClient({
  signer: privateKey(key),
  store: fileStore('./.xo-credentials'),
});
```

The files hold secrets. Keep the directory out of git, and give each running process its own.
To keep credentials in a vault or a database instead, implement
[`CredentialStore`](reference/client/interfaces/CredentialStore.md).

## Bring your own credentials

If you already hold the credentials of this wallet, pass them as `credentials` and the client
uses them instead of signing in for new ones. `exportCredentials()` gives exactly the shape the
option takes.

<!-- snippet: docs/snippets/authentication.ts#saved-credentials -->
```ts
const client = await createSecureClient({
  signer: privateKey(key),
  credentials: saved,
});
```

The client checks them when it is created, before it uses or stores them:

- A given API key must belong to the wallet's account and needs the `account:read` scope. The
  client reads your account with it, in one request with no signature.
- Given order book credentials must be the wallet's own default ones, the ones that signing in
  derives. The check costs one wallet signature.

Anything else is refused with `credentials_not_owned`, and nothing is stored or revoked. The client
never rotates credentials you gave it, and `close()` leaves them active.

## Close the client, or sign out

<!-- snippet: docs/snippets/authentication.ts#close -->
```ts
await client.close();
```

`close()` means this process is done. The client places no new order, stops its heartbeat, closes
its subscriptions and, if it signed in for a 1-day key, revokes that key. A key from a persistent
store stays for the next start. It never rejects. With the default memory store, the client also
closes itself on SIGINT and SIGTERM and when the process ends normally, so a script needs no
`close()`. After `process.exit()` or a crash nothing runs, and the 1-day key expires within a day.
Pass `shutdownHooks: false` to handle all this yourself.

<!-- snippet: docs/snippets/authentication.ts#end-authentication -->
```ts
const publicClient = await client.endAuthentication();
const { items } = await publicClient.listMarkets().firstPage();
```

`endAuthentication()` signs the wallet out for good. It revokes the API key whether the client
signed in for it, loaded it from a store or was given it, deletes it from the store, and deletes
the wallet's order book API key. It returns a public client for the same environment.

| | `close()` | `endAuthentication()` |
| --- | --- | --- |
| The API key | Revoked only if it is a 1-day key this client made. | Always revoked, and deleted from the store. |
| The order book key | Kept. | Deleted. |
| The client afterwards | Every member throws `client_closed`. | The same, and you get a public client. |

> [!WARNING]
> The order book API key belongs to the wallet, not to the process: every process that trades
> with the same wallet shares it. `endAuthentication()` deletes it for all of them, and each one
> signs in again for a new key the next time it needs one. In a fleet that shares a wallet, call
> `close()` on shutdown, and keep `endAuthentication()` for retiring the wallet.

## Replace or revoke a key

An account holds at most 10 active API keys. List them, and replace the one the client holds
with `rotateCredentials()`. It signs in for a new key, stores it, then revokes the old one.

<!-- snippet: docs/snippets/authentication.ts#rotate-key -->
```ts
for await (const page of client.listApiKeys()) {
  for (const key of page.items) {
    console.log(`${key.name} ${key.prefix}… expires ${key.expiresAt}`);
  }
}
await client.rotateCredentials();
```

A key can revoke only itself, so there is no method that revokes another key. To retire the key
a client uses, call `endAuthentication()`. `rotateCredentials()` refuses a key you passed as
`credentials` (`credentials_provided`). Unused keys expire on their own. To free a slot sooner,
write to gm@xo.market.
