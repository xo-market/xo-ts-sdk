# Wallets and authentication

## Sign in

<!-- snippet: docs/snippets/authentication.ts#sign-in -->
```ts
const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK ?? ''),
});
console.log(`Trading as ${client.wallet}`);
```

`createSecureClient` signs in before it returns. `client.wallet` is the address that holds the
funds and trades: your key's own, unless you trade through a
[smart wallet](#trade-through-a-smart-wallet). Any signer from
[Wallet integrations](README.md#wallet-integrations) works. A wallet client, such as a browser or hardware
wallet, can sign in and trade, but on-chain sends like approvals, transfers and withdrawals fail
with `sign_hash_unsupported`. Use a private key or a viem account for those.

Never put a key on the command line, like `XO_PK=0x… node bot.js`: your shell saves it in its
history. Keep it in a gitignored `.env` file, and never turn on socket.io-client's debug logging:
it prints the API key.

## Keep credentials across restarts

<!-- snippet: docs/snippets/authentication.ts#file-store -->
```ts
const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK ?? ''),
  store: fileStore('./.xo-credentials'), // from @xomarket/client/node
});
```

Without a store, every start signs in for a new 1-day API key. An account holds at most 10
active keys, then creating a client fails with `api_key_limit_reached`. `fileStore` keeps one
90-day key across restarts and replaces it before it expires. `rotateCredentials()` swaps the key
for a new one at any time.

Keep the store's folder private and out of git, one per process. For a vault or other storage,
implement [`CredentialStore`](reference/client/interfaces/CredentialStore.md).

## Reuse credentials

<!-- snippet: docs/snippets/authentication.ts#saved-credentials -->
```ts
const saved = await client.exportCredentials(); // secret: never log it

const again = await createSecureClient({ signer, credentials: saved });
```

The second client uses them instead of signing in.

## Close the client

<!-- snippet: docs/snippets/authentication.ts#close -->
```ts
await client.close();
```

`close()` stops the client in this process and revokes its 1-day key. A key in a store stays for
the next start. Without a store, a script needs no `close()`: its key is revoked on Ctrl-C,
SIGTERM and a normal exit.

## Sign out for good

<!-- snippet: docs/snippets/authentication.ts#end-authentication -->
```ts
const publicClient = await client.endAuthentication();
```

`endAuthentication()` revokes the API key, deletes it from the store and returns a public
client. It also deletes the order book key that every process of that wallet shares; `close()`
does not.

## Trade through a smart wallet

A smart wallet is an account your key owns: the key signs, and the smart wallet holds the USDC
and trades. For a new account, your key's own address is simpler.

<!-- snippet: docs/snippets/authentication.ts#smart-wallet-address -->
```ts
const signer = privateKey(process.env.XO_PK ?? '');
const wallet = await createPublicClient().fetchSmartWalletAddress({
  owner: await signer.getAddress(),
  index: 0,
});
console.log(`Smart wallet 0: ${wallet}`);
```

The address is known before the wallet exists. Smart wallets 0–9 only: never fund a higher one.

<!-- snippet: docs/snippets/authentication.ts#smart-wallet-client -->
```ts
const client = await createSecureClient({ signer, wallet });
```

The first time, this deploys the smart wallet once, gas-free, with its trading approvals. If
that throws with `mayHaveLanded: true`, find the transaction before you create the client again.
An address your key does not own is refused with `wallet_not_owned`.

> [!WARNING]
> Send USDC to the smart wallet's address, never the key's. The smart wallet can't trade USDC
> held at your key's address.

## Set up approvals

<!-- snippet: docs/snippets/authentication.ts#setup -->
```ts
const transaction = await client.setupTradingApprovals();
console.log(transaction?.transactionHash ?? 'Nothing to set up');
```

An existing smart wallet may lack its approvals. This sends only what is missing.

## Trade your XO website account

Your XO website account is a smart wallet. To trade it from your server:

## 1. Export your login key

Export the private key of the wallet you log in to XO with. If the website offers no export,
write to gm@xo.market. Never send the key to anyone, XO included.

## 2. Check the address

Check that the key's smart wallet 0, read as above, is your account's address on the website.

## 3. Create the client

Create the client with that key and address, then call `setupTradingApprovals()`.

Your server and the website then share the same USDC, positions and orders: `cancelAll()` and a
stopped heartbeat cancel the website's orders too.

## Next steps

- [Place orders](place-orders.md)
- [Deposit](deposit.md)
- [Errors](errors.md)
