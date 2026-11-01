# Wallets and sign-in

## Sign in

<!-- snippet: docs/snippets/authentication.ts#sign-in -->
```ts
const client = await createSecureClient({ signer: privateKey(key) });
console.log(`Trading as ${client.wallet}`);
```

`createSecureClient` signs in with your wallet key before it returns, so there is no separate
login call. `privateKey` comes from `@xomarket/client/viem`.

`client.wallet` is the address that holds the funds and trades. It is your key's own address,
unless you trade through a [smart wallet](smart-wallets.md).

Never type the key on a command line: your shell saves it in its history. See
[Keep keys out of logs](production.md#keep-keys-out-of-logs).

## Use another signer

<!-- snippet: docs/snippets/authentication.ts#signer-from-account -->
```ts
const client = await createSecureClient({ signer: signerFrom(account) });
```

`signerFrom` turns a viem account into a signer, such as one that a key management service signs
for. You can also write your own [`Signer`](reference/client/interfaces/Signer.md).

## Keep credentials across restarts

<!-- snippet: docs/snippets/authentication.ts#file-store -->
```ts
const client = await createSecureClient({
  signer: privateKey(key),
  store: fileStore('./.xo-credentials'),
});
```

Without a store, every start signs in for a new 1-day API key. `fileStore` from
`@xomarket/client/node` keeps one 90-day key across restarts and replaces it before it expires.

The files are secret. Keep the folder out of git, and give each process its own. To keep
credentials somewhere else, such as a vault, implement
[`CredentialStore`](reference/client/interfaces/CredentialStore.md).

## Reuse credentials

<!-- snippet: docs/snippets/authentication.ts#saved-credentials -->
```ts
const saved = await client.exportCredentials();

const again = await createSecureClient({
  signer: privateKey(key),
  credentials: saved,
});
```

`exportCredentials()` returns the client's API key and order book key. They are secret, so never
log them. A client given them as `credentials` uses them instead of signing in for new ones. It
checks first that they belong to the wallet, and it never rotates them.

## Close the client

<!-- snippet: docs/snippets/authentication.ts#close -->
```ts
await client.close();
```

`close()` ends the client in this process. It stops its heartbeat and subscriptions, and revokes
the 1-day key it signed in for. A key in a store stays for the next start, and the order book key
is kept.

Without a store, a script needs no `close()`. The client revokes its 1-day key by itself on
Ctrl-C, SIGTERM and a normal exit.

## Sign out for good

<!-- snippet: docs/snippets/authentication.ts#end-authentication -->
```ts
const publicClient = await client.endAuthentication();
const { items } = await publicClient.listMarkets().firstPage();
```

`endAuthentication()` revokes the API key, deletes it from the store, and deletes the wallet's
order book key. It returns a public client.

> [!WARNING]
> Every process that trades with this wallet shares its order book key, and
> `endAuthentication()` deletes it for all of them. To stop one process, call `close()`.

## Replace an API key

<!-- snippet: docs/snippets/authentication.ts#rotate-key -->
```ts
for await (const page of client.listApiKeys()) {
  for (const key of page.items) {
    console.log(key.name, key.expiresAt);
  }
}
await client.rotateCredentials();
```

An account holds at most 10 active API keys. `rotateCredentials()` signs in for a new key, then
revokes the old one. Unused keys expire by themselves. To free a slot sooner, write to
gm@xo.market.

## Next steps

- [Place an order](orders.md)
- [Trade through a smart wallet](smart-wallets.md)
- [Run in production](production.md)
