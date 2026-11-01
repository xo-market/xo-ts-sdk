# Smart wallets

## When to use one

Use a smart wallet when your account already trades through one, like an XO website account.
For a new account, your key's own address is simpler.

## Find the address

<!-- snippet: docs/snippets/smart-wallets.ts#smart-wallet-address -->
```ts
const owner = await signer.getAddress();
const wallet = await client.fetchSmartWalletAddress({ owner, index: 0 });
console.log(`Smart wallet 0: ${wallet}`);
```

A key's smart wallets are numbered 0, 1, 2…, and each address is known before the wallet exists.
A public client can read it. The SDK trades smart wallets 0 to 9 only, so never fund a higher one.
USDC sent to a wrong address is gone.

## Create the client

<!-- snippet: docs/snippets/smart-wallets.ts#make-client -->
```ts
const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
  wallet: requireEnv('XO_SMART_WALLET'),
});
console.log(`Trading as ${client.wallet}`);
```

Pass the smart wallet's address as `wallet`. Your key signs, and the smart wallet holds the funds
and trades. An address that is not one of your key's smart wallets is refused with
`wallet_not_owned`.

If the smart wallet does not exist, creating the client deploys it once, gas-free, and sets its
trading approvals in the same transaction. If that transaction's outcome is unknown, the error
says `mayHaveLanded: true`. Find the transaction before you create the client again. See
[When the outcome is unknown](onchain.md#when-the-outcome-is-unknown).

> [!WARNING]
> Send USDC to the smart wallet's address, never to your key's. USDC at your key's address is not
> in the account, and the smart wallet cannot trade with it.

## Set up approvals

<!-- snippet: docs/snippets/smart-wallets.ts#setup -->
```ts
const transaction = await client.setupTradingApprovals();
console.log(transaction?.transactionHash ?? 'Nothing to set up');
```

A smart wallet that already exists may still lack its trading approvals. This sends only what is
missing.

## Trade your XO website account

An XO website account is a smart wallet owned by the wallet you log in with. To trade it from
your server:

1. Export the private key of the wallet you log in with. If the website offers no export, write
   to gm@xo.market. Never send the key to anyone, XO included.
2. Read that key's smart wallet 0, as above, and check that it is your account's address on the
   website.
3. Create the client with that key and that address, then run `setupTradingApprovals()`.

Your server and the website then share one account: the same USDC, positions and orders.
`cancelAll()` cancels the orders you placed on the website too.

> [!WARNING]
> If your server runs a heartbeat and it stops, XO cancels every open order of the account about
> 30 seconds later, the website's included.

## Next steps

- [Place an order](orders.md)
- [Read balances and move funds](onchain.md)
- [Wallets and sign-in](authentication.md)
