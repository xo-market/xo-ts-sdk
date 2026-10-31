# Function: createSecureClient()

```ts
function createSecureClient(options): Promise<SecureClient>;
```

Creates a client that signs in with a wallet. It resolves once the client has signed in:
the wallet's API key is loaded from the `store` or signed in for (one wallet signature), and
its order book credentials are derived, or created the first time (one more signature).
Credentials given in `credentials` are checked to be the wallet's first (see the option),
and then used without signing in for new ones.

Before any of that, the `wallet` address is checked against the signer: the signer's own
address, or one of its smart wallets (read from the chain). An address the signer does not
own is refused before anything is signed or sent to XO.

An undeployed smart wallet is deployed once, gas-free, when the client is created: XO's
order book checks a smart wallet's signatures on chain, so it cannot sign in before. Once
given credentials are checked and before it signs in, the client sends, through XO's sponsor,
the one transaction that [SecureClient.setupTradingApprovals](../interfaces/SecureClient.md#setuptradingapprovals) would send: it makes the
smart wallet and sets its approvals for trading. It waits for the transaction to be mined.
The transaction is sent once, never again and never signed again; when it fails, no client
is made and no key is left signed in for. A smart wallet that exists already, or the signer's
own address, is sent nothing.

With the default memory store the API key lasts a day, and the client revokes it on
`close()`, on SIGINT or SIGTERM and when the process exits normally (see `shutdownHooks`).
When creating the client fails after a key was signed in for, that key is revoked before
the error is thrown. `JSON.stringify` and `util.inspect` of the client show its wallet
address, never a credential.

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`SecureClientOptions`](../interfaces/SecureClientOptions.md) | The `signer` (required), the `wallet` to trade from, `credentials` to reuse, the credential `store`, and the options of [createPublicClient](createPublicClient.md). |

## Returns

`Promise`\<[`SecureClient`](../interfaces/SecureClient.md)\>

## Throws

`invalid_input` for a missing `signer`, a key that is not
  an option or an option of the wrong type (the message never repeats a value);
  `wallet_not_owned` for a `wallet` the signer does not own; `credentials_not_owned` for
  `credentials` that are not the wallet's (nothing is stored or revoked then);
  `direct_rail_eoa_only` for
  `rail: 'direct'` with a smart wallet; `sponsor_not_configured` for `rail: 'sponsored'`, or an
  undeployed smart wallet, on an environment without a sponsor;
  `smart_wallet_address_unavailable` when the chain cannot be read; the errors of deploying an
  undeployed smart wallet: a `chain_read_failed` `XoError` and the signer's `SigningError`
  before it is sent, the sponsor's refusals (`mayHaveLanded: false`), a
  `TransactionFailedError` `tx_reverted` when it was mined and reverted, and a
  `TransactionFailedError` with `mayHaveLanded: true` and the `transactionHash` (or, when the
  sponsor's answer was lost, the executor `nonce`) when its outcome is unknown: check it
  before you create the client again; and the errors of signing in: the signer's
  (`SigningError`), a refusal (`api_key_limit_reached` when the account has 10 active keys)
  and the request errors.

## Example

```ts
const client = await createSecureClient({ signer: privateKey(process.env.XO_PK as string) });
console.log(client.wallet, await client.fetchTradingState());
```
