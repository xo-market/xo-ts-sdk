# Errors

## Tell errors apart

Every error the SDK throws is an `XoError`, with a `code` that stays the same between releases.

<!-- snippet: docs/snippets/errors.ts#tell-apart -->
```ts
try {
  return await client.fetchMarket({ slug });
} catch (error) {
  if (error instanceof RequestRejectedError && error.status === 404) {
    return null;
  }
  throw error;
}
```

A `UserInputError` means nothing was sent. A `RequestRejectedError` means a service answered with an
error, and its `code` is the service's own. Each method's errors also have a guard, such as
`FetchMarketError.isError`.

Errors are safe to log, since keys and secrets are removed. To report a problem, send the `code`,
`message` and `requestId` to gm@xo.market.

## If `mayHaveLanded` is true

The order, cancel, transaction or payment may have gone through. The SDK never sends it again.
Reconcile it before you send anything again:

- Order: `reconcileOrder({ orderHash: error.orderHash })`. A `not_found` is not proof, so check
  again later.
- Cancel: read `listOpenOrders()`.
- Transaction: look up `error.transactionHash`, or your signer's transaction with `error.nonce`.
- Deposit or withdrawal: read `fetchBridgePayment({ paymentId: error.paymentId })`.

## Requests and input

| Code | Class | What to do |
| --- | --- | --- |
| `invalid_input` | `UserInputError` | Fix the input the message names. |
| `invalid_request_options` | `UserInputError` | Fix `retries`, `timeout` or `signal`. |
| `invalid_cursor` | `UserInputError` | Pass an unchanged `nextCursor` of the same list. |
| `invalid_market_url` | `UserInputError` | Pass a market link: `https://xo.market/markets/<slug>`. |
| `pagination_limit` | `PaginationLimitError` | Narrow the list with filters. |
| `not_binary` | `UserInputError` | Only YES/NO markets trade. Pick another. |
| `market_not_binary` | `UnexpectedResponseError` | Not a YES/NO market. Pick another. |
| `not_tradable_on_orderbook` | `RequestRejectedError`, `UserInputError` | No order book. Pick another market. |
| `timeout` | `TimeoutError` | Retry. For an order, reconcile first. |
| `transport_error` | `TransportError` | Check the network. For an order, reconcile first. |
| `request_aborted` | `RequestAbortedError` | Your `signal` aborted it. |
| `unexpected_response` | `UnexpectedResponseError`, `MintedKeyError`, `XoError` | See `issues`. For an order, reconcile first. |
| `http_<status>` | `RateLimitError`, `RequestRejectedError` | Such as `http_502`. Wait `retryAfter` ms if set. |

## Setup and sign-in

| Code | Class | What to do |
| --- | --- | --- |
| `insecure_transport` | `UserInputError` | Use `https:` URLs. |
| `invalid_private_key` | `UserInputError` | Pass `0x` and 64 hex characters. |
| `chain_not_configured` | `UserInputError` | A bug. Report it. |
| `rail_not_configured` | `UserInputError` | A bug. Report it. |
| `sponsor_not_configured` | `UserInputError` | Leave out `environment`, or set `sponsorUrl`. |
| `bridge_not_available` | `UserInputError` | Leave out `environment`. |
| `direct_rail_eoa_only` | `UserInputError` | Leave out `rail` for a smart wallet. |
| `direct_rail_single_call` | `UserInputError` | Leave out `rail`. |
| `signer_mismatch` | `UserInputError` | Sign with the owner's key. |
| `smart_wallet_address_mismatch` | `UserInputError` | Check your `environment`. On mainnet, report it. |
| `wallet_not_owned` | `UserInputError` | Pass a wallet the signer owns. |
| `ws_not_open` | `UserInputError` | A bug. Report it. |
| `auth_required` | `AuthRequiredError` | Use `createSecureClient`. |
| `api_key_limit_reached` | `RequestRejectedError` | 10 keys are active. Let some expire. |
| `key_route_not_found` | `XoError` | Update `@xomarket/client`, then report it. |
| `credentials_provided` | `XoError` | Leave out `credentials` to rotate keys. |
| `credentials_not_owned` | `UserInputError` | Pass this wallet's own credentials. |
| `credential_store_unavailable` | `XoError` | Make the `fileStore` folder writable. |
| `session_closed` | `XoError` | Create a new client. |
| `client_closed` | `UserInputError` | Create a new client. |
| `topic_needs_sign_in` | `UserInputError` | Subscribe on a client from `createSecureClient`. |
| `api_key_not_listed` | `XoError` | Not revoked. Let it expire, or ask XO. |
| `smart_wallet_not_deployed` | `XoError` | Retry in a moment. |
| `smart_wallet_deployment_unknown` | `XoError` | Retry, then check your RPC. |
| `smart_wallet_address_unavailable` | `XoError` | Retry, then check your RPC. |
| `signing_failed` | `SigningError` | Your signer failed. Nothing was sent. |
| `sign_hash_unsupported` | `SigningError` | Use `privateKey`, or `signerFrom` with a local account. |
| `signature_mismatch` | `SigningError` | `signHash` must sign the raw digest with the owner's key. |
| `invalid_credentials` | `RequestRejectedError` | Revoked or expired. Leave out `credentials`. |
| `invalid_signature` | `RequestRejectedError` | Check your signer and `wallet`. |
| `insufficient_scope` | `RequestRejectedError` | Use a key the SDK signed in for. |
| `frontend_only` | `RequestRejectedError` | Use the SDK's methods. |
| `api_key_can_only_revoke_itself` | `RequestRejectedError` | Let the other key expire. |

## Orders

| Code | Class | What to do |
| --- | --- | --- |
| `placement_failed` | `PlacementError` | If `mayHaveLanded`, reconcile `error.orderHash`. |
| `batch_place_incomplete` | `BatchPlaceIncompleteError` | If `mayHaveLanded`, reconcile each of `error.failedChunk`. |
| `batch_ops_incomplete` | `BatchOpsIncompleteError` | If `mayHaveLanded`, reconcile each of `error.orderHashes`. |
| `nonce_unavailable` | `XoError` | Retry, then check your RPC. |
| `trading_paused` | `RequestRejectedError` | Nothing was placed. Wait `error.retryAfter` ms. |
| `order_in_delay_window` | `RequestRejectedError` | Cancel again in a moment. |
| `order_cancelled_during_hold` | `RequestRejectedError` | Place a new one if needed. |
| `heartbeat_not_tracked` | `XoError` | The beat didn't count. Check your credentials. |
| `heartbeat_failed` | `XoError` | 30 s of misses cancels your orders. |
| `heartbeat_already_running` | `UserInputError` | `stop()` the running one first. |

## Rejected orders

A refused order is not thrown. The placement returns `{ ok: false, code, message }`, and
nothing was placed. `insufficient_balance`, `trading_paused` and `order_cancelled_during_hold`
come back this way too.

| Code | Class | What to do |
| --- | --- | --- |
| `post_only_would_cross` | none | Price it away from the book. |
| `duplicate_order` | none | Already placed. Look it up by `orderHash`. |
| `size_below_minimum` | none | Place at least one share. |
| `notional_below_minimum` | none | Under $0.001. Raise the size or price. |
| `price_out_of_range` | none | Use a price from 0.001 to 0.999. |
| `invalid_expiration` | none | Set an expiration further ahead. |
| `market_not_active` | none | The market isn't open. Check `market.state`. |
| `market_not_found` | none | Use an `assetId` from a fetched market. |
| `insufficient_position` | none | Sell fewer shares, or cancel a resting sell. |
| `account_not_found` | none | Check `client.wallet`. |
| `rejected` | none | Read `message`. |

## On chain

| Code | Class | What to do |
| --- | --- | --- |
| `chain_read_failed` | `XoError`, `TransactionFailedError` | Retry, then check your RPC. |
| `chain_rpc_failed` | `XoError` | Retry, then check your RPC. |
| `bundle_simulation_reverted` | `XoError` | It would revert. Check balances and approvals. |
| `gas_estimation_failed` | `TransactionFailedError` | It would revert. Check balances and approvals. |
| `previous_operation_pending` | `TransactionFailedError` | Retry once `error.nonce` is mined. |
| `sponsor_outcome_unknown` | `TransactionFailedError` | Don't resend. Find the transaction with `error.nonce`. |
| `executor_mismatch` | `TransactionFailedError` | Don't resend. Report `error.transactionHash`. |
| `receipt_timeout` | `TransactionFailedError` | Don't resend. Look up `error.transactionHash` later. |
| `receipt_unavailable` | `TransactionFailedError` | Don't resend. Look up `error.transactionHash`. |
| `broadcast_outcome_unknown` | `TransactionFailedError` | Don't resend. Look up `error.transactionHash`. |
| `nonce_already_used` | `TransactionFailedError` | Don't resend. Find the transaction with `error.nonce`. |
| `nonce_too_low` | `TransactionFailedError` | Don't resend. Look up `error.transactionHash`. |
| `rejected_by_node` | `TransactionFailedError` | Fix the cause, then send again. |
| `tx_reverted` | `TransactionFailedError` | Run `setupTradingApprovals()` again. |
| `send_failed` | `TransactionFailedError` | If `mayHaveLanded`, reconcile before you resend. |
| `skipped_after_ambiguous` | `TransactionFailedError` | Reconcile the earlier redeem, then run `redeemAllPositions()` again. |
| `recipient_is_token_contract` | `UserInputError` | Check the `to` address. |
| `insufficient_balance` | `UserInputError` | Not enough USDC. Add funds, or use less. |
| `nothing_to_merge` | `UserInputError` | See `fetchMarketCapacity` for free shares. |
| `amount_exceeds_free` | `UserInputError` | Merge less, or cancel sell orders. |
| `not_resolved` | `UserInputError` | Not resolved yet. Wait, then redeem. |
| `policy_rejected` | `RequestRejectedError` | XO won't pay the gas. For tokens other than USDC, use `rail: 'direct'`. |

## Deposits and withdrawals

To check a payment, read `fetchBridgePayment({ paymentId: error.paymentId })`.

| Code | Class | What to do |
| --- | --- | --- |
| `bridge_funding_mismatch` | `TransactionFailedError` | Nothing was sent. Check the payment. |
| `bridge_funding_claimed` | `TransactionFailedError` | This call sent no USDC. Follow the message. |
| `bridge_wait_timeout` | `TimeoutError` | Check the payment. Never confirm or fund it again. |
| `bridge_wait_callback_failed` | `XoError` | A bug. Report it. |
| `verification_required` | `AuthRequiredError` | Finish it with `verifyBridgePayment`. |
| `verification_payload_refused` | `SigningError` | Don't sign it another way. Report it. |
| `funding_already_claimed` | `RequestRejectedError` | Comes as `bridge_funding_claimed`. |
| `asset_not_supported` | `RequestRejectedError` | Use an asset from `listBridgeAssets`. |
| `amount_invalid` | `RequestRejectedError` | Too many decimal places. |
| `amount_out_of_range` | `RequestRejectedError` | Quote within the limits in the message. |
| `recipient_invalid` | `RequestRejectedError` | Check `recipient`. Withdrawals are final. |
| `recipient_family_unsupported` | `RequestRejectedError` | Withdraw to EVM networks or Solana. |
| `owner_unknown` | `RequestRejectedError` | Report the account's address. |
| `payment_not_found` | `RequestRejectedError` | Check the id. Unconfirmed quotes go after an hour. |
| `quote_expired` | `RequestRejectedError` | Quote again, and confirm before `acceptBy`. |
| `verification_failed` | `RequestRejectedError` | Call `verifyBridgePayment` again. |
| `payment_not_awaiting_verification` | `RequestRejectedError` | Check the payment's `status`. |
| `payment_not_awaiting_funds` | `RequestRejectedError` | It may be funded. Check the payment first. |
| `not_a_withdrawal` | `RequestRejectedError` | Fund a deposit yourself. |
| `cursor_invalid` | `RequestRejectedError` | Start `listBridgePayments()` again. |
| `bridge_unavailable` | `RequestRejectedError` | Quote again. After a confirm, check the payment. |
| `bridge_rejected` | `RequestRejectedError` | Quote again. After a confirm, check the payment. |

## Live data

These come as `'error'` events of a subscription. To read a topic again, use `fetchOrderBooks`
for `market`, `listOpenOrders` for `user` and `listPositions` for `portfolio`.

| Code | Class | What to do |
| --- | --- | --- |
| `ws_frame_invalid` | `UnexpectedResponseError` | Report it if it repeats. |
| `ws_unknown_event` | `UnexpectedResponseError` | Safe to ignore. |
| `ws_tokens_unresolved` | `XoError` | Read those books with `fetchOrderBooks`. |
| `ws_auth_failed` | `XoError` | Retried. Check the network if it lasts. |
| `ws_auth_unrecoverable` | `XoError` | Closed. Fix the credentials, then subscribe again. |
| `ws_subscribe_refused` | `XoError` | Read the topic again on `'reconnected'`. |
| `ws_server_error` | `XoError` | Read the topic again on `'reconnected'`. |
| `ws_events_dropped` | `XoError` | Read the topic in `error.topic` again. |
| `ws_stale` | `TransportError` | Read the topic again on `'reconnected'`. |
| `ws_connect_timeout` | `TimeoutError` | Retried. Check the network if it lasts. |
| `max_ws_connections_exceeded` | `XoError` | Close subscriptions you don't need. |
| `ws_callback_failed` | `XoError` | Report it. |
| `ws_subscribe_failed` | `XoError` | Report it if it repeats. |
| `ws_subscribe_unrecoverable` | `XoError` | Closed. Fix the cause, then subscribe again. |
| `ws_auth_refused` | `XoError` | Nothing to do. |
| `ws_snapshot_failed` | `XoError` | Wait, or subscribe again. |
| `ws_anonymous_viewer` | `XoError` | A bug. Report it. |
| `ws_channel_failed` | `XoError` | Report it. |
| `subscription_overflow` | `XoError` | Read every topic again. Do less per event. |
| `browser_secret_refused` | `UserInputError` | Run the `user` topic on your server. |
| `INSUFFICIENT_SCOPE` | `XoError` | Closed. Use a key with `account:read`. |
| `EVENT_TOO_LARGE` | `XoError` | A bug. Report it. |
| `INVALID_FILTER` | `XoError` | A bug. Report it. |
| `INVALID_EVENT_ID` | `XoError` | A bug. Report it. |
| `TAKE_LIMIT` | `XoError` | A bug. Report it. |
| `RATE_LIMITED` | `XoError` | Subscribe to fewer topics. |
| `API_KEY_INVALID` | `XoError` | Revoked or expired. Leave out `credentials`. |

## Next steps

- [Place an order](orders.md)
- [Production checklist](production.md)
- [Every error class](reference/client/classes/XoError.md)
