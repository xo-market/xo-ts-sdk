# Smart wallets

## When you need one

Use a smart wallet when the account already trades through one, as an account made on the XO
website does. For a new account, the plain wallet (the default) is simpler, with nothing to
deploy.

## Find the address

A smart wallet is named by its address, and a key has smart wallets 0, 1, 2… The address of each
is fixed before the wallet exists, so you can read it before you deploy anything. The read is
public, so a plain `createPublicClient()` is enough: one call to the chain, no call to XO's API
and nothing signed. `index` is 0 when you leave it out.

<!-- snippet: docs/snippets/smart-wallets.ts#smart-wallet-address -->
```ts
const owner = await signer.getAddress();

for (const index of [0, 1, 2]) {
  const wallet = await client.fetchSmartWalletAddress({ owner, index });
  console.log(`smart wallet ${index} of ${owner}: ${wallet}`);
}
```

You can send USDC to this address before the wallet exists: creating the client deploys the
wallet there. `createSecureClient` takes smart wallets 0 to 9 only, so USDC sent to a smart
wallet with a higher index could not be traded with the SDK. Check the address before you send
anything, since USDC sent to a wrong address is gone.

## Create the client

Pass the smart wallet's address as `wallet`. Your key stays the `signer`.

<!-- snippet: docs/snippets/smart-wallets.ts#make-client -->
```ts
const signer = privateKey(requireEnv('XO_PK'));
const client = await createSecureClient({
  signer,
  wallet: requireEnv('XO_SMART_WALLET'),
});
```

Your key signs, and the smart wallet trades and holds the funds. The SDK recognises ten smart
wallets of a signer, numbered 0 to 9. Before anything is signed or sent, it reads the chain to
check that `wallet` is one of them; any other address is refused with `wallet_not_owned`.
`client.wallet` is then the smart wallet's address.

<!-- snippet: docs/snippets/smart-wallets.ts#addresses -->
```ts
console.log(
  `signer ${await signer.getAddress()}, trading as ${client.wallet}`,
);
```

> [!WARNING]
> Mainnet is real money. Send USDC to the smart wallet's address, never to the owner's. USDC
> at the owner's address is not the account's, and the smart wallet cannot trade with it.

## A new smart wallet is deployed for you

The order book checks a smart wallet's signatures against its code, so the wallet has to exist
before the client can sign in. When it does not exist yet, creating the client deploys it, once.
XO's sponsor sends the transaction and pays the gas, and the client waits until it is mined. The
same transaction sets the approvals for trading, the ones `setupTradingApprovals()` sends. A smart
wallet that exists already is sent nothing.

If the transaction's outcome is unknown, no client is made and the error is a
`TransactionFailedError` with `mayHaveLanded: true`. It carries the `transactionHash`, or, when
the sponsor's answer was lost, the executor `nonce`. Find the transaction before you create the
client again: see [Balances and on-chain](onchain.md#when-the-outcome-is-unknown).

`rail: 'direct'` cannot be used with a smart wallet.

## Approvals of a wallet that exists

A smart wallet that exists but never set up its approvals gets them with `setupTradingApprovals`.
It sends only what is missing, and nothing for a wallet that already traded.

<!-- snippet: docs/snippets/smart-wallets.ts#setup -->
```ts
const transaction = await client.setupTradingApprovals();
console.log(
  transaction === null
    ? 'setup: approved already, nothing sent'
    : `setup: sent in transaction ${transaction.transactionHash}`,
);
```

After that, everything works as with a plain wallet.

## Trade your XO website account

An account made on the XO website is a smart wallet, owned by the wallet you log in with. To
trade it from your server:

1. Export the private key of the wallet you log in with. If the XO website offers no export,
   write to gm@xo.market. Never send the key to anyone, XO included.
2. Read the address of that key's smart wallet 0 with `fetchSmartWalletAddress`, as above, and
   check that it is your account's address on the website.
3. Create the client above with that key, and the address as `wallet`.
4. Check that `client.wallet` is your account's address on the website, then run
   `setupTradingApprovals()`. It sends nothing for a smart wallet that already traded.

Your server and the website now share one account: the same USDC, positions and orders.
`cancelAll()` also cancels the orders you placed on the website.

> [!WARNING]
> A heartbeat covers the whole account. If your server runs one and stops, XO cancels every open
> order of the account about 30 seconds later, the website's included.
