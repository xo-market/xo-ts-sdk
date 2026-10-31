# Errors

Every error the SDK throws is an `XoError` with a stable `code`.

## Read an error

Catch `XoError` and switch on its `code`. The subclasses follow the kind of failure: a
`UserInputError` is input the SDK refused before sending anything, and a `RequestRejectedError`
is a service that answered with an error status (its `status` says which, and `code` is the
service's own, such as `market_not_found` for a 404 or `trading_paused` for a 503).

To know which errors a call can throw, use the guard of the same name as its error type, such as
`FetchMarketError`. Its `isError` narrows what you caught to exactly those errors. The type of
each method's errors is in the [API reference](reference/client/interfaces/PublicClient.md).

<!-- snippet: docs/snippets/errors.ts#describe-error -->
```ts
function describeError(error: unknown): string {
  return error instanceof XoError
    ? `${error.name} ${error.code}${error.mayHaveLanded === undefined ? '' : ` mayHaveLanded=${error.mayHaveLanded}`}: ${error.message}`
    : String(error);
}
```

| Field | What it holds |
| --- | --- |
| `code` | A stable code, such as `smart_wallet_not_deployed`. |
| `message` | What went wrong, in plain words. |
| `service` | Who raised it: `backend`, `orderbook`, `sponsor`, `chain`, or `sdk` for the SDK itself. |
| `status` | The HTTP status, when a service answered. |
| `requestId` | The server's id for the request, when it sent one. |
| `mayHaveLanded` | Whether the order, cancel, transaction or payment may have gone through anyway. |
| `orderHash` | The hash of the order whose placement failed. |
| `paymentId` | The id of the deposit or withdrawal the error is about. |
| `topic` | The topic of a subscription the error is about: `market`, `user`, `portfolio` or `activity`. |
| `retryAfter` | How long the service asked you to wait, in milliseconds, on a `RateLimitError` or a `RequestRejectedError`. |
| `transactionHash`, `nonce` | On a `TransactionFailedError`: the transaction, and the executor nonce it was signed with. |

Logging an error is safe. The SDK redacts keys and secrets from its `message`, `code`, `requestId`
and `toJSON()`.

To report a problem, write to gm@xo.market with the `code`, `message` and `requestId`.

## If `mayHaveLanded` is true

> [!WARNING]
> The order, cancel, transaction or payment may have gone through. Never resend or re-sign an
> order, a transaction or a payment. A cancel may be sent again once you have read your open orders.

The SDK never resends anything for you. Find out what happened first:

- An order: `reconcileOrder({ orderHash: error.orderHash })` answers `resting`, `traded` or
  `not_found`. A `not_found` is not proof, so check again later. A batch error lists the hashes
  to check in `failedChunk` or `orderHashes`.
- A deposit or withdrawal: read it with `fetchBridgePayment({ paymentId: error.paymentId })` and
  follow its `status`.
- A transaction: look up `error.transactionHash`. Without one, find the transaction from your
  signer's address that used `error.nonce`: see [Balances and on-chain](onchain.md#when-the-outcome-is-unknown).
- A cancel: read your open orders with `listOpenOrders`. An order that is gone may have been
  cancelled or may have filled. Then cancel again the ones still open.

## Input and setup

| Code | Class | What to do |
| --- | --- | --- |
| `invalid_input` | `UserInputError` | Fix the input the message names. Nothing was sent. |
| `insecure_transport` | `UserInputError` | Use `https:` URLs in the `environment` you pass. |
| `invalid_private_key` | `UserInputError` | Pass `privateKey` a `0x` and 64 hex characters (32 bytes), such as `process.env.XO_PK`. The message never shows the key. |
| `invalid_request_options` | `UserInputError` | Fix the read's options: `retries` 0 to 5, `timeout` a whole number of ms or `false`, `signal` an `AbortSignal`. |
| `invalid_cursor` | `UserInputError` | Pass `from` the `nextCursor` of a page of the same list, exactly as it was given. A cursor of another list, of another SDK version, or one that was cut short or changed is refused. |
| `invalid_market_url` | `UserInputError` | Pass `fetchMarket({ url })` the link of a market page on XO's website: `https://xo.market/markets/<slug>` (a subdomain such as `beta.xo.market` works too). Event pages and other links are refused; the message names the host only. |
| `pagination_limit` | `PaginationLimitError` | A list can be read only to a fixed depth. The last page it reaches says `limitReached: true`, and asking for more throws this. Narrow the list with filters to reach the rest. |
| `chain_not_configured` | `UserInputError` | This should not reach you. Report it. |
| `rail_not_configured` | `UserInputError` | This should not reach you. Report it. |
| `sponsor_not_configured` | `UserInputError` | Leave out `environment` for XO mainnet, or set `sponsorUrl` in the environment you pass. |
| `bridge_not_available` | `UserInputError` | The environment has no bridge. Leave out `environment` for XO mainnet. |
| `direct_rail_eoa_only` | `UserInputError` | A smart wallet can't use `rail: 'direct'`. Leave the `rail` option out. |
| `direct_rail_single_call` | `UserInputError` | The direct rail sends one call per transaction, and `setupTradingApprovals` needs more than one. Use the default rail. |
| `signer_mismatch` | `UserInputError` | Use one signer everywhere. A payment needs the wallet that confirmed it. |
| `smart_wallet_address_mismatch` | `UserInputError` | Check the factory contracts of the `environment` you pass. On mainnet, report it. |
| `credentials_not_owned` | `UserInputError` | The `credentials` you passed are not the wallet's: an API key of another account, or order book credentials other than the wallet's own default ones (pass what `exportCredentials()` gives). Nothing was stored or revoked. |
| `wallet_not_owned` | `UserInputError` | Pass as `wallet` the signer's own address or one of its smart wallets (numbers 0 to 9), or leave it out. `fetchSmartWalletAddress({ owner, index })` reads the address of each. Nothing was signed or sent. |
| `ws_not_open` | `UserInputError` | This should not reach you. Report it. |

## Auth and signing

| Code | Class | What to do |
| --- | --- | --- |
| `auth_required` | `AuthRequiredError` | Pass the credentials the call needs: create the client with `createSecureClient({ signer })`. |
| `api_key_limit_reached` | `RequestRejectedError` | The account has 10 active API keys. Keep your credentials with `fileStore`, or let old keys expire. |
| `key_route_not_found` | `XoError` | Update `@xomarket/client`. If the newest version still fails, report it. |
| `credentials_provided` | `XoError` | `rotateCredentials()` never rotates a key you passed in `credentials`. Create the client without `credentials`, so that it signs in for a key of its own. |
| `credential_store_unavailable` | `XoError` | Check that the `fileStore` directory exists and the process can write to it. |
| `session_closed` | `XoError` | The client was closed while the call ran. Create a new one with `createSecureClient`. |
| `client_closed` | `UserInputError` | The client was closed or signed out. Create a new one with `createSecureClient`, or read public data with the client `endAuthentication()` returned. Nothing was sent. |
| `topic_needs_sign_in` | `UserInputError` | The `user` and `portfolio` topics read your account: subscribe to them on a client from `createSecureClient`. Nothing was opened. |
| `api_key_not_listed` | `XoError` | The key you passed in `credentials` is not among the account's 100 newest keys, so `endAuthentication()` could not revoke it. Ask XO to revoke it, or let it expire. |
| `smart_wallet_not_deployed` | `XoError` | `createSecureClient` deploys a new smart wallet before it signs in, so this means the chain read has not caught up. Create the client again in a moment, then check your RPC. |
| `smart_wallet_deployment_unknown` | `XoError` | A chain read failed. Try again, then check your RPC. |
| `smart_wallet_address_unavailable` | `XoError` | The smart wallet factory could not be read, by `fetchSmartWalletAddress` or by `createSecureClient`. Try again, then check your RPC. |
| `signing_failed` | `SigningError` | Your signer threw or returned a bad signature. Nothing was sent. |
| `sign_hash_unsupported` | `SigningError` | On-chain sends need `privateKey`, or `signerFrom` with a local account. |
| `signature_mismatch` | `SigningError` | A custom `signHash` must sign the raw digest with the owner's key. |
| `verification_required` | `AuthRequiredError` | The payment waits for the owner. Finish it with `verifyBridgePayment({ paymentId: error.paymentId, verify })`. |
| `verification_payload_refused` | `SigningError` | The SDK never signs this payload. Don't sign it another way; report the `paymentId`. |

## Orders

| Code | Class | What to do |
| --- | --- | --- |
| `placement_failed` | `PlacementError` | If `mayHaveLanded` is true, call `reconcileOrder({ orderHash: error.orderHash })`. Otherwise it was not placed. |
| `batch_place_incomplete` | `BatchPlaceIncompleteError` | A batch failed, or XO did not say what became of some orders. Never resend them. If `mayHaveLanded`, reconcile each hash of `error.failedChunk`. `error.results` holds the orders XO answered for (match them by `orderHash`), and `error.notSent` the hashes never sent. |
| `batch_ops_incomplete` | `BatchOpsIncompleteError` | If `mayHaveLanded`, reconcile each of `error.orderHashes` and read your open orders again with `listOpenOrders`. |
| `nonce_unavailable` | `XoError` | Reading your exchange nonce failed. Try again, then check your RPC. |

## Rejected orders

An order that XO refuses is not thrown. The placement returns `{ ok: false, orderHash, code, message }`
and nothing was placed. Switch on `code`; `message` is XO's own words and can change. No error class
raises these codes, so the Class column reads "none". Three more codes also come back this way and are
listed under their own headings: `insufficient_balance` (not enough USDC), `trading_paused` and
`order_cancelled_during_hold`.

| Code | Class | What to do |
| --- | --- | --- |
| `post_only_would_cross` | none | The order would have traded at once, which `postOnly` forbids. Price it away from the book, or place it without `postOnly`. |
| `duplicate_order` | none | This exact signed order is already on the book or has already traded. Don't send it again: look it up by `orderHash`. |
| `size_below_minimum` | none | Place at least one share. |
| `notional_below_minimum` | none | The order is worth less than $0.001 at this price. Raise the size or the price. |
| `price_out_of_range` | none | Use a price from 0.001 to 0.999. |
| `invalid_expiration` | none | The expiration is missing, in the past or too soon. Give a good-til-date order an expiration that is still ahead when it arrives. |
| `market_not_active` | none | The market has not started, is paused, or is over. Check `market.state` before you place. |
| `market_not_found` | none | XO has no market for this `assetId`. Take it from a market you fetched. |
| `insufficient_position` | none | You hold fewer shares than the order sells, not counting shares held back by your resting sell orders. Sell fewer, or cancel a resting order. |
| `account_not_found` | none | XO does not know this trading account. Check that `client.wallet` is the account you meant, and if it keeps happening, write to gm@xo.market with the `orderHash`. |
| `rejected` | none | Any other refusal. Read `message`. If it keeps happening, write to gm@xo.market with it. |

## Heartbeat

| Code | Class | What to do |
| --- | --- | --- |
| `heartbeat_not_tracked` | `XoError` | The beat didn't count; check your credentials. After 30 s of misses, all your orders are cancelled. |
| `heartbeat_failed` | `XoError` | A beat failed (see `cause`). One miss is fine, a run of misses is not. |
| `heartbeat_already_running` | `UserInputError` | `stop()` the running heartbeat first, or keep using it. |

## On chain

| Code | Class | What to do |
| --- | --- | --- |
| `chain_read_failed` | `XoError`, `TransactionFailedError` | A chain read failed and nothing was sent. Try again, then check your RPC. |
| `chain_rpc_failed` | `XoError` | A call of your chain reader failed. Try again, then check your RPC. |
| `bundle_simulation_reverted` | `XoError` | The calls would revert. Check the balances and approvals they need. |
| `gas_estimation_failed` | `TransactionFailedError` | The transaction would revert. Check balances and approvals; `setupTradingApprovals()` sets the approvals. |
| `previous_operation_pending` | `TransactionFailedError` | An earlier transaction may still land. Wait until the one with `error.nonce` is mined, then retry. |
| `sponsor_outcome_unknown` | `TransactionFailedError` | The sponsor may have sent it. Never resend; find the transaction from your signer's address that used `error.nonce`: see [Balances and on-chain](onchain.md#when-the-outcome-is-unknown). |
| `executor_mismatch` | `TransactionFailedError` | It went out from another account. Never resend; check `error.transactionHash` and report it. |
| `receipt_timeout` | `TransactionFailedError` | No receipt after 120 s, and it may still land. Never resend; look up `error.transactionHash` later. |
| `receipt_unavailable` | `TransactionFailedError` | Reading the receipt failed. Never resend; look up `error.transactionHash` when the RPC answers. |
| `broadcast_outcome_unknown` | `TransactionFailedError` | It may have reached the network. Never resend; look up `error.transactionHash`. |
| `nonce_already_used` | `TransactionFailedError` | Never resend. Find the transaction from your signer's address that used `error.nonce`. |
| `nonce_too_low` | `TransactionFailedError` | The nonce is used, maybe by this transaction. Look up its hash first. |
| `rejected_by_node` | `TransactionFailedError` | The node refused it for sure (see the message). Fix the cause and send again. |
| `tx_reverted` | `TransactionFailedError` | The `setupTradingApprovals()` transaction reverted. It is also what `createSecureClient` sends to deploy a new smart wallet. Call `setupTradingApprovals()` or create the client again: both read the chain again and send only what is missing. |
| `send_failed` | `TransactionFailedError` | A send failed unexpectedly. If `mayHaveLanded` is true, never resend; reconcile first. |
| `skipped_after_ambiguous` | `TransactionFailedError` | `redeemAllPositions()` stopped after an unknown outcome. Reconcile that market, then run it again. |
| `bridge_funding_mismatch` | `TransactionFailedError` | Nothing was sent. Check `fetchBridgePayment({ paymentId: error.paymentId })`, and don't send USDC to it by hand. |
| `bridge_funding_claimed` | `TransactionFailedError` | The claim is used and this call sent no USDC. Check `fetchBridgePayment({ paymentId: error.paymentId })` first. |
| `recipient_is_token_contract` | `UserInputError` | You tried to send tokens to a token contract. Check `to`. |
| `insufficient_balance` | `UserInputError` | Not enough USDC at the trading address. Fund it, or send less. A refused order carries the same code. |
| `nothing_to_merge` | `UserInputError` | Merging needs free YES and NO shares. Check `fetchMarketCapacity({ conditionId })`. |
| `amount_exceeds_free` | `UserInputError` | Merge at most the free amount in the message, or cancel the SELL orders that reserve shares. |
| `not_resolved` | `UserInputError` | The market is not resolved on chain yet. Wait, then redeem. |

## Markets

| Code | Class | What to do |
| --- | --- | --- |
| `not_tradable_on_orderbook` | `RequestRejectedError`, `UserInputError` | The market doesn't trade on the orderbook. Pick another market. |
| `not_binary` | `UserInputError` | The SDK trades binary YES/NO markets only. Pick another market. |
| `market_not_binary` | `UnexpectedResponseError` | The market doesn't have exactly two outcomes, so it can't be read as a YES/NO market. Pick another market. |

## Realtime

These arrive as `'error'` events of a subscription handle, with the topic they are about in
`error.topic` (the one exception is `subscription_overflow`, which is about the whole handle). The
stream goes on unless the row says it closed. See [Live data](realtime.md).

| Code | Class | What to do |
| --- | --- | --- |
| `ws_frame_invalid` | `UnexpectedResponseError` | A bad frame was dropped. Read the topic again if it matters; report it if it repeats. |
| `ws_unknown_event` | `UnexpectedResponseError` | Comes only with `strictResponses: true`. Safe to ignore otherwise. |
| `ws_tokens_unresolved` | `XoError` | No initial book arrived for some tokens. Read them with `fetchOrderBooks`. |
| `ws_auth_failed` | `XoError` | The SDK retries. Check the network if it lasts. |
| `ws_auth_unrecoverable` | `XoError` | The connection closed. Fix the credentials, then subscribe again. |
| `ws_subscribe_refused` | `XoError` | The connection restarts. Read the topic again when `'reconnected'` fires. |
| `ws_server_error` | `XoError` | The service sent an error. Read the topic again when `'reconnected'` fires. |
| `ws_events_dropped` | `XoError` | Events were dropped. Read the topic named in `error.topic` again: `fetchOrderBooks` for `market`, `listOpenOrders` for `user`, `listPositions` for `portfolio`. |
| `ws_stale` | `TransportError` | The socket went silent and reconnects. Read the topic again on `'reconnected'`. |
| `ws_connect_timeout` | `TimeoutError` | The SDK retries. Check the network if it lasts. |
| `max_ws_connections_exceeded` | `XoError` | Too many open sockets. Close the subscriptions you don't need. |
| `ws_callback_failed` | `XoError` | An internal callback threw and the stream goes on. Report it. |
| `ws_subscribe_failed` | `XoError` | The connection restarts. Nothing to do unless it repeats. |
| `ws_subscribe_unrecoverable` | `XoError` | The topic closed after three refusals. Fix the cause, then subscribe again. |
| `ws_auth_refused` | `XoError` | The key was refused and replaced. The connection restarts by itself. |
| `ws_snapshot_failed` | `XoError` | The next change sends a new snapshot. Close the handle and subscribe again to retry now. |
| `ws_anonymous_viewer` | `XoError` | This should not reach you. Report it. |
| `ws_channel_failed` | `XoError` | An internal failure, and the stream goes on. Report it. |
| `subscription_overflow` | `XoError` | Your loop read too slowly and old events were dropped. Read every topic again, and do less per event. |
| `browser_secret_refused` | `UserInputError` | The `user` topic sends your order book credentials, so it won't run in a browser. Use your server. |

## Requests

| Code | Class | What to do |
| --- | --- | --- |
| `timeout` | `TimeoutError` | Try again later. For a placement, reconcile `error.orderHash` first. |
| `bridge_wait_timeout` | `TimeoutError` | The payment goes on. Read `fetchBridgePayment({ paymentId: error.paymentId })`; never confirm or fund it again. |
| `bridge_wait_callback_failed` | `XoError` | This should not reach you. Report it. |
| `transport_error` | `TransportError` | No response came. Check the network; for a placement, reconcile first. |
| `request_aborted` | `RequestAbortedError` | Your `signal` aborted the call; `cause` is its reason. Nothing to do. |
| `unexpected_response` | `UnexpectedResponseError`, `MintedKeyError`, `XoError` | The answer didn't match (`issues` says where). For a placement, reconcile first. |
| `http_<status>` | `RateLimitError`, `RequestRejectedError` | A service error with no code of its own, such as `http_502`. A 429 is a `RateLimitError`; it and a `RequestRejectedError` with a `Retry-After` carry `retryAfter` in milliseconds. |

## Service codes

A service's own code reaches you as the error's `code`. These are the ones the SDK knows by name.

| Code | Class | What to do |
| --- | --- | --- |
| `trading_paused` | `RequestRejectedError` | Trading is paused and nothing was placed. Wait `error.retryAfter` milliseconds, then place again. An order refused because of the pause carries the same code. |
| `invalid_credentials` | `RequestRejectedError` | The API key is unknown, revoked or expired. For a key you passed in `credentials`, create the client without it to sign in for a new one. |
| `invalid_signature` | `RequestRejectedError` | Check that your signer signs the message as given. For a smart wallet, check the `wallet` address. |
| `insufficient_scope` | `RequestRejectedError` | The key lacks the scope. Use a key the SDK signed in for. |
| `frontend_only` | `RequestRejectedError` | The route is for the XO website only. Use what the SDK offers. |
| `api_key_can_only_revoke_itself` | `RequestRejectedError` | A key can revoke only itself. Let the other key expire, or write to gm@xo.market. |
| `order_in_delay_window` | `RequestRejectedError` | The order is in the taker-delay window. Try the cancel again in a moment. |
| `order_cancelled_during_hold` | `RequestRejectedError` | It was cancelled during the taker delay and does not rest. Place a new one if needed. A refused order carries the same code. |
| `funding_already_claimed` | `RequestRejectedError` | You get `bridge_funding_claimed` instead. Follow that row. |
| `asset_not_supported` | `RequestRejectedError` | Use an `assetId` from `listBridgeAssets({ direction })`, exactly as listed. |
| `amount_invalid` | `RequestRejectedError` | Too many decimal places. Check the asset's `decimals` in `listBridgeAssets({ direction })`. |
| `amount_out_of_range` | `RequestRejectedError` | The amount is outside the limits in the message. Quote again with another amount. |
| `recipient_invalid` | `RequestRejectedError` | Check `recipient`. A valid but wrong address passes, and a withdrawal is final. |
| `recipient_family_unsupported` | `RequestRejectedError` | Withdrawals go to EVM networks and Solana only. Pick another asset. |
| `owner_unknown` | `RequestRejectedError` | The account has no owner wallet on file. Report the account's address. |
| `payment_not_found` | `RequestRejectedError` | Check the id and the account. An unconfirmed quote is deleted after an hour. |
| `quote_expired` | `RequestRejectedError` | Quote again and confirm before `acceptBy`. Never retry the old quote. |
| `verification_failed` | `RequestRejectedError` | If the payment still needs verification, call `verifyBridgePayment` again. |
| `payment_not_awaiting_verification` | `RequestRejectedError` | Read `fetchBridgePayment({ paymentId: error.paymentId })` and follow its `status`. |
| `payment_not_awaiting_funds` | `RequestRejectedError` | Another call may have funded it. Check `fetchBridgePayment({ paymentId: error.paymentId })` before you send anything. |
| `not_a_withdrawal` | `RequestRejectedError` | You fund a deposit yourself. Use `createDeposit` for a deposit quote. |
| `cursor_invalid` | `RequestRejectedError` | Start the list again with `listBridgePayments()`. |
| `bridge_unavailable` | `RequestRejectedError` | The bridge provider is down. Quote again; after a confirm, read `fetchBridgePayment({ paymentId: error.paymentId })`. |
| `bridge_rejected` | `RequestRejectedError` | The bridge provider refused it. Quote again; after a confirm, read `fetchBridgePayment({ paymentId: error.paymentId })`. |
| `policy_rejected` | `RequestRejectedError` | The sponsor won't pay for this call, and nothing was sent. For a token other than USDC, `rail: 'direct'` sends it yourself from a plain wallet. Otherwise report it. |
| `INSUFFICIENT_SCOPE` | `XoError` | The channel closed. Use a key with `account:read`, then subscribe again. |
| `EVENT_TOO_LARGE` | `XoError` | This should not reach you. Report it. |
| `INVALID_FILTER` | `XoError` | This should not reach you. Report it. |
| `INVALID_EVENT_ID` | `XoError` | This should not reach you. Report it. |
| `TAKE_LIMIT` | `XoError` | This should not reach you. Report it. |
| `RATE_LIMITED` | `XoError` | The channel reconnects by itself. Subscribe to fewer topics if it lasts. |
| `API_KEY_INVALID` | `XoError` | The key was revoked or expired. For a key you passed in `credentials`, create the client without it to sign in for a new one. |
