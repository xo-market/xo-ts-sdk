import { type Hex, verifyMessage, verifyTypedData } from 'viem';
import type { ChainReader, TxResult } from '../account/chain';
import {
  type AccountClient,
  preflightSend,
  readUsdcBalance,
} from '../account/client';
import { withLanded } from '../account/internal';
import type { Session } from '../auth/session';
import { isSameAddress, normalizeAddress } from '../core/address';
import { fromMicro } from '../core/decimal';
import type { EnvironmentConfig } from '../core/env';
import {
  AuthRequiredError,
  SigningError,
  TransactionFailedError,
  UserInputError,
  XoError,
} from '../core/errors';
import { cursorPaginator, type Paginator } from '../core/paginate';
import type { CallOptions } from '../core/requestOptions';
import { sleep } from '../core/retry';
import type { Transport } from '../core/transport';
import { closedObject } from '../orderbook/internal';
import type { TradingIdentity } from '../wallet/identity';
import { errorName, isObject, normalizeSignature } from '../wallet/internal';
import type { InternalSigner } from '../wallet/signer';
import {
  assertBridgeAvailable,
  assertFundingNotClaimed,
  assertWithdrawalOfQuote,
  BRIDGE_BASE,
  BRIDGE_POLL_MS,
  type BridgeDeps,
  bridgeRequest,
  claimShowsDeposit,
  compareDecimal,
  type FundingTarget,
  fundingClaimed,
  fundingClaimedOtherInstructions,
  HISTORY_PAGE_SIZE,
  isFinalStatus,
  isTransientRead,
  landedAfterPost,
  type QuoteBody,
  readDirection,
  readFundingTarget,
  readHistoryOptions,
  readPaymentId,
  readQuoteBody,
  readQuotedMicro,
  readQuoteOption,
  readQuoteRecipient,
  readVerifyOption,
  readWaitOptions,
  waitTimedOut,
  withPaymentId,
} from './internal';
import {
  type BridgeAsset,
  BridgeAssetsSchema,
  type BridgeDirection,
  type BridgeFundingClaim,
  BridgeFundingClaimSchema,
  type BridgeHistoryOptions,
  type BridgePayment,
  BridgePaymentPageSchema,
  BridgePaymentSchema,
  type BridgeQuote,
  type BridgeQuotes,
  BridgeQuotesSchema,
  type BridgeWithdrawal,
} from './schemas';
import {
  decodeVerificationItems,
  payloadRefused,
  type VerificationRequest,
  type VerifyCallback,
} from './verification';

// The bridge client: deposits into XO and withdrawals out of it, through the bridge provider.
// Every method passes the gate first (`assertBridgeAvailable`): an environment without the
// bridge fails with `bridge_not_available` before anything else is looked at or sent.

/**
 * The options of {@link BridgeClient}. The secure client wires them from its one session, so
 * they are the same transport, session, chain reader and account client as the rest of the
 * client: the bridge needs the session's credentials, and a withdrawal moves USDC through the
 * account client.
 */
export interface BridgeClientOptions {
  /** The environment. Its `bridge` field must be set, or every method fails with `bridge_not_available`. */
  env: EnvironmentConfig;
  /** The SDK transport, with the session installed (`transport.setAuth(session)`). */
  transport: Transport;
  /** The session. With neither a signer nor a backend key every method fails at once with `AuthRequiredError`. */
  session: Session;
  /** Who trades: the wallet deposits land in and withdrawals leave from. Called per operation, never cached. */
  identity: () => Promise<TradingIdentity>;
  /** The owner's signer, for the calls that sign. */
  signer?: InternalSigner;
  /** Reads balances on chain. */
  chain: ChainReader;
  /** The account client, which sends the USDC of a withdrawal. */
  account: AccountClient;
  /** Reject response fields the schemas do not know (for contract tests). */
  strictResponses?: boolean;
}

/** The options of {@link BridgeClient.wait}. Every one is optional. */
export interface BridgeWaitOptions {
  /**
   * How long to wait in all, in milliseconds, counted from the call. A number above 0 and at
   * most 86 400 000 (24 hours). Defaults to 3 600 000 (one hour). When it passes with the
   * payment not final, `wait` fails with `bridge_wait_timeout`.
   */
  timeoutMs?: number;
  /**
   * Ends the wait early. When it aborts, `wait` rejects with `signal.reason`, as it is, at once
   * when it is sleeping or reading. An `onUpdate` call it is awaiting is not cut short: the
   * callback runs until it settles, and only then does the wait end (with the payment, if that
   * read found it final). The wait itself leaves no timer or listener behind.
   */
  signal?: AbortSignal;
  /**
   * Called with the payment at the first read and at each read after which the `status`
   * differs from the last one seen. It is not called for a read that failed. If it returns a
   * promise, the wait waits for it. If it throws (or the promise rejects), the wait ends with
   * an error: an `XoError` you throw comes out as it is, with the `paymentId` added; anything
   * else comes out as `bridge_wait_callback_failed`, with what you threw as its `cause`. The
   * one exception is the `signal`'s own reason: a callback that rejects with it (because it
   * awaits something that uses the same signal) ends the wait with that reason, as it is.
   */
  onUpdate?: (payment: BridgePayment) => void;
}

/** Every option of {@link BridgeClientOptions}: any other key is refused. */
const OPTION_KEYS = [
  'env',
  'transport',
  'session',
  'identity',
  'signer',
  'chain',
  'account',
  'strictResponses',
] as const;

/** The options, checked. */
interface Checked {
  env: EnvironmentConfig;
  transport: Transport;
  session: Session;
  identity: () => Promise<TradingIdentity>;
  signer: InternalSigner | undefined;
  chain: ChainReader;
  account: AccountClient;
  strict: boolean;
}

function checkOptions(o: unknown): Checked {
  const options = closedObject(o, 'options', OPTION_KEYS);
  const { env, transport, session, identity, signer, chain, account } = options;
  if (!isObject(env) || !isObject(env.contracts)) {
    throw new UserInputError('env must be an environment config');
  }
  if (!isObject(transport) || typeof transport.request !== 'function') {
    throw new UserInputError('transport must be a Transport (request)');
  }
  if (
    !isObject(session) ||
    typeof session.hasSigner !== 'function' ||
    typeof session.hasBackendCredential !== 'function' ||
    typeof session.toJSON !== 'function'
  ) {
    throw new UserInputError('session must be a Session');
  }
  if (typeof identity !== 'function') {
    throw new UserInputError(
      'identity must be a function that resolves the trading identity',
    );
  }
  if (
    signer !== undefined &&
    (!isObject(signer) ||
      typeof signer.signMessage !== 'function' ||
      typeof signer.signTypedData !== 'function')
  ) {
    throw new UserInputError('signer must be a Signer object');
  }
  if (!isObject(chain) || typeof chain.readContract !== 'function') {
    throw new UserInputError('chain must be a ChainReader (readContract)');
  }
  if (!isObject(account) || typeof account.transferUsdc !== 'function') {
    throw new UserInputError('account must be an AccountClient (transferUsdc)');
  }
  if (
    options.strictResponses !== undefined &&
    typeof options.strictResponses !== 'boolean'
  ) {
    throw new UserInputError('strictResponses must be true or false');
  }
  return {
    env: env as unknown as EnvironmentConfig,
    transport: transport as unknown as Transport,
    session: session as unknown as Session,
    identity: identity as Checked['identity'],
    signer: signer as InternalSigner | undefined,
    chain: chain as unknown as ChainReader,
    account: account as unknown as AccountClient,
    strict: options.strictResponses === true,
  };
}

/**
 * The error for a verification the caller did not approve (no callback, an answer that was not
 * `true`, or a callback that threw, which is `cause`): nothing was signed.
 */
function verificationRequired(
  message: string,
  cause?: unknown,
): AuthRequiredError {
  return new AuthRequiredError(message, {
    code: 'verification_required',
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Signs one decoded request with the owner's signer: `signTypedData` of the typed data the
 * callback saw (the very object, not a copy), or `signMessage` of its text, and the signature in
 * the form the chain recovers (65 bytes, `v` 27 or 28). The signature must recover to the
 * signer's address for what was shown, or it is not used: a signer that signs something else, or
 * with another key, is caught before anything is sent.
 *
 * @throws {SigningError} `signing_failed` when the signer throws (only its error name is
 *   kept, never its message), answers something that is not a signature, or answers one that
 *   does not recover to `signer.address`.
 */
async function signRequest(
  signer: InternalSigner,
  request: VerificationRequest,
): Promise<Hex> {
  let raw: unknown;
  try {
    raw =
      request.decoded.kind === 'eip712'
        ? await signer.signTypedData(request.decoded.typedData)
        : await signer.signMessage(request.decoded.message);
  } catch (error) {
    // No cause: a wallet's error is not ours to vouch for.
    throw new SigningError(
      `The signer failed on a verification item (${errorName(error)}): nothing was sent`,
    );
  }
  const signature = normalizeSignature(raw);
  let recovers = false;
  try {
    recovers =
      request.decoded.kind === 'eip712'
        ? await verifyTypedData({
            ...request.decoded.typedData,
            address: signer.address,
            signature,
          } as Parameters<typeof verifyTypedData>[0])
        : await verifyMessage({
            address: signer.address,
            message: request.decoded.message,
            signature,
          });
  } catch {
    recovers = false;
  }
  if (!recovers) {
    throw new SigningError(
      "A signature the signer returned does not recover to the signer's address for what was shown: nothing was sent",
    );
  }
  return signature;
}

/**
 * Deposits into XO and withdrawals out of it, through the bridge: the engine of the secure
 * client's deposit and withdrawal members.
 *
 * **Off unless the environment has a bridge.** A deposit or withdrawal is only possible where
 * the environment has a `bridge` (`production` does). Every
 * method checks that first: without it the call fails with a `UserInputError`
 * `bridge_not_available` and `mayHaveLanded: false`, before anything else is checked or sent.
 *
 * **Composed only.** The bridge needs the session's credentials and a withdrawal sends USDC
 * through the account client, so the secure client builds it for its deposit and withdrawal
 * members.
 *
 * **Credentials.** Every route is the account's own: it is sent with the session's backend
 * key, logs in with the session's signer when it has none, and fails with an
 * `AuthRequiredError` before any request when the session has neither.
 *
 * **Errors.** Every error that leaves the bridge has a boolean `mayHaveLanded`.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class BridgeClient {
  readonly #deps: BridgeDeps;
  readonly #identity: () => Promise<TradingIdentity>;
  readonly #signer: InternalSigner | undefined;
  readonly #chain: ChainReader;
  readonly #account: AccountClient;

  /**
   * Checks the options and requests nothing.
   * @throws {UserInputError} For an unknown option, or an option of the wrong kind.
   */
  constructor(o: BridgeClientOptions) {
    const checked = checkOptions(o);
    // The requests need the deps; a verification needs the signer and the identity; a
    // withdrawal reads the balance with the chain reader and sends USDC with the account client.
    this.#deps = {
      env: checked.env,
      transport: checked.transport,
      session: checked.session,
      strict: checked.strict,
    };
    this.#identity = checked.identity;
    this.#signer = checked.signer;
    this.#chain = checked.chain;
    this.#account = checked.account;
  }

  /**
   * The tokens a deposit can be paid in (`'deposit'`) or a withdrawal can be sent out as
   * (`'withdraw'`). A deposit lands as XO USDC in the trading wallet whatever it is paid in.
   *
   * Send an asset's `asset` id back as the `asset` of a quote.
   *
   * @param direction `'deposit'` or `'withdraw'`.
   * @throws {UserInputError} `bridge_not_available` when the environment has no bridge;
   *   `invalid_input` for any other `direction`. Both with `mayHaveLanded: false`, and
   *   nothing sent.
   * @throws {AuthRequiredError} Without a signer or a backend key: nothing sent.
   * @throws {RequestRejectedError} Status 404, `bridge_not_available` when the backend has the bridge switched off.
   */
  async assets(
    direction: BridgeDirection,
    call?: CallOptions,
  ): Promise<BridgeAsset[]> {
    assertBridgeAvailable(this.#deps.env);
    const checked = readDirection(direction);
    const answer = await bridgeRequest(this.#deps, {
      method: 'GET',
      path: `${BRIDGE_BASE}/assets`,
      query: { direction: checked },
      schema: BridgeAssetsSchema,
      call,
    });
    return answer.data;
  }

  /**
   * Asks for quotes to deposit `amount` of `asset` into XO. A deposit lands as XO USDC in the
   * trading wallet whatever it is paid in; each option of the answer says how much USDC it
   * pays out and what it costs.
   *
   * A quote costs nothing and moves nothing: it only stores the options, which can be
   * confirmed until `acceptBy`. The options are sorted by `output.amount`, the one that pays
   * out the most first, compared as decimals and not as text. Send an option back to confirm
   * it (see `deposit`).
   *
   * An `amount` that is a number goes through `String(n)`, so `0.5` is `'0.5'`; one that
   * prints with an exponent (`1e-7`) is refused, as is anything but a decimal above 0 with at
   * most 36 decimal places. Nothing is rounded.
   *
   * @param o.asset An asset id from `assets('deposit')`, such as `base:0x8335…2913`.
   * @param o.amount How much of `asset` to pay in, in whole units: a decimal string, or a number.
   * @throws {UserInputError} `bridge_not_available` when the environment has no bridge;
   *   `invalid_input` for an unknown option, an asset that is not an asset id or an amount
   *   that is refused; these carry `mayHaveLanded: false` and nothing was sent.
   * @throws {RequestRejectedError} Status 400: the backend's refusals keep their codes, with
   *   `mayHaveLanded: false`: `asset_not_supported`, `amount_out_of_range` (the message names
   *   the bounds) and `amount_invalid` (more decimal places than the asset has).
   * @throws {AuthRequiredError} Without a signer or a backend key: nothing sent.
   * @throws {RequestRejectedError} Status 5xx, `bridge_unavailable`, `bridge_rejected` and other
   *   server failures, a {@link TimeoutError}, a {@link TransportError} or an
   *   {@link UnexpectedResponseError}: `mayHaveLanded: true`. The request is never repeated. A
   *   quote moves no money, so `true` here only means that quotes may have been stored: ask
   *   again.
   *
   * With `call`, the quote is a read instead: it is retried as one, with the call's options, and
   * every error has `mayHaveLanded: false` (a quote moves nothing).
   */
  async quoteDeposit(
    o: {
      asset: string;
      amount: string | number;
    },
    call?: CallOptions,
  ): Promise<BridgeQuotes> {
    assertBridgeAvailable(this.#deps.env);
    return this.#quote(readQuoteBody('deposit', o), call);
  }

  /**
   * Asks for quotes to withdraw `amount` of XO USDC from the trading wallet as `asset`, sent to
   * `recipient`. Each option says how much of `asset` the recipient gets and what it costs.
   *
   * A quote costs nothing and moves nothing, and the options are sorted as in `quoteDeposit`.
   * Confirming one is `withdraw`'s job. **The recipient can be any address, and one that is
   * valid but wrong is final**: check it before you confirm.
   *
   * @param o.asset An asset id from `assets('withdraw')`, such as `base:0x8335…2913`.
   * @param o.amount How much XO USDC to send, in whole units: a decimal string, or a number,
   *   checked as in `quoteDeposit`.
   * @param o.recipient The address that receives `asset` on its network, as the network writes
   *   it. It is sent as it is given.
   * @throws {UserInputError} As `quoteDeposit`, and `invalid_input` for a recipient that is
   *   blank or longer than 128 characters.
   * @throws {RequestRejectedError} Status 400, as `quoteDeposit`; the backend's
   *   `recipient_invalid` (the address is not one on the asset's network) carries
   *   `mayHaveLanded: false`.
   * @throws {AuthRequiredError} Without a signer or a backend key: nothing sent.
   * @throws {RequestRejectedError} Status 5xx, as `quoteDeposit`: `mayHaveLanded: true` for a server
   *   failure, a timeout or a lost connection.
   *
   * With `call`, the quote is a read, as for `quoteDeposit`.
   */
  async quoteWithdraw(
    o: {
      asset: string;
      amount: string | number;
      recipient: string;
    },
    call?: CallOptions,
  ): Promise<BridgeQuotes> {
    assertBridgeAvailable(this.#deps.env);
    return this.#quote(readQuoteBody('withdraw', o), call);
  }

  /**
   * Confirms a deposit quote: the quote option becomes a deposit, and the payment that comes back
   * says where to send the funds (`payment.deposit`: a one-time address, the amount and the
   * token). Sending them is up to you; `get(paymentId)` shows the payment from there.
   *
   * ```ts
   * const { quotes } = await bridge.quoteDeposit({ asset, amount: '25' });
   * const payment = await bridge.deposit(quotes[0]);
   * console.log(payment.status, payment.deposit);
   * ```
   *
   * **Confirming happens once.** The request is never repeated by the SDK. A quote can be
   * confirmed until its `acceptBy`; the backend answers a repeated confirm with the stored
   * payment. Whatever the backend answers is returned, so check `status`:
   * `'CONFIRM_UNKNOWN'` means the backend's own confirm is still running or ended unknown: the
   * payment has no `deposit` block yet, so read it with `get(paymentId)` until it has one, and
   * do not send funds before.
   *
   * **Verification is opt-in.** For some payments the bridge provider asks the owner wallet to
   * sign before it goes on (`status: 'NEEDS_VERIFICATION'`). Those payloads come from a server,
   * so the SDK signs only through your `verify` callback:
   *
   * 1. Every item is decoded and checked first. Some payloads are always refused, whatever the
   *    callback says (see `verification_payload_refused`): XO's own orders and login, token
   *    permits and orders, smart-account wrappers, a domain bound to an XO contract, to the
   *    trading wallet or to the signer, a value that does not fit its Solidity type, an unknown
   *    `reason`, text that is not plain printable ASCII.
   * 2. The callback is then called once per item, in order, with the decoded
   *    {@link VerificationRequest}; it approves by returning exactly `true`. The first answer
   *    that is not `true`, or the first throw, stops it.
   * 3. Only after it approved every item is anything signed, with the signer of the client (it
   *    must be the payment's owner). Each signature must recover to that signer for what the
   *    callback was shown. The signatures are sent once, and the payment that comes back is
   *    returned.
   *
   * Without a `verify` callback, when it answers no, or when it throws (the throw is the
   * error's `cause`), the call fails with `verification_required` and nothing is signed. The
   * payment is confirmed all the same, and stays `'NEEDS_VERIFICATION'`: finish it with
   * {@link BridgeClient.verify}.
   *
   * **Errors.** Every error carries `mayHaveLanded` and the `paymentId`. After a failure with
   * `mayHaveLanded: true` read the payment with `get(paymentId)` before anything else, and
   * never confirm the quote again for it. After `verification_required` the quote's id is the
   * payment's: `verify(paymentId, ...)` finishes it.
   *
   * @param quote A quote option from `quoteDeposit`. Only its `paymentId` and `direction` are read.
   * @param o.verify Approves each item the owner is asked to sign. Called with a
   *   {@link VerificationRequest}; answer `true` to approve it.
   * @throws {UserInputError} `bridge_not_available` when the environment has no bridge;
   *   `invalid_input` for a quote that is not a deposit quote option (a withdrawal quote
   *   included) or for options that are wrong; `signer_mismatch` when the client's signer is
   *   not the payment's owner. All with `mayHaveLanded: false`.
   * @throws {RequestRejectedError} Status 422 `verification_failed` when the bridge provider
   *   refused the signatures, with `mayHaveLanded: false`.
   * @throws {AuthRequiredError} `auth_required` without a backend key or a signer (a signer is
   *   needed only when the payment asks for verification: that error comes after the confirm,
   *   with the `paymentId`); `verification_required` when there is no callback, it did not
   *   approve every item, or it threw or rejected (whatever it threw: nothing is signed, and the
   *   throw is the `cause`). `mayHaveLanded: false`.
   * @throws {SigningError} `verification_payload_refused` for a payload that is never signed;
   *   `signing_failed` when the signer threw, returned no signature, or returned one that does
   *   not recover to the signer's address for what the callback was shown (a signer that signed
   *   other data or used another key; a contract wallet's signature, which cannot be recovered
   *   to an address, is refused the same way). `mayHaveLanded: false`.
   * @throws {RequestRejectedError} Status 409, `quote_expired` (the quote can no longer be confirmed) and
   *   `payment_not_awaiting_verification`. `mayHaveLanded: false`.
   * @throws {RequestRejectedError} Status 404, `payment_not_found`: no quote or payment of this account has that
   *   id. `mayHaveLanded: false`.
   * @throws {RequestRejectedError} Status 5xx, `bridge_unavailable`, `bridge_rejected` and other
   *   server failures, a {@link TimeoutError}, a {@link TransportError} or an
   *   {@link UnexpectedResponseError}: `mayHaveLanded: true`.
   */
  async deposit(
    quote: BridgeQuote,
    o: { verify?: VerifyCallback } = {},
  ): Promise<BridgePayment> {
    assertBridgeAvailable(this.#deps.env);
    const id = readQuoteOption(quote, 'deposit');
    const verify = readVerifyOption(o, false);
    const payment = await this.#confirm(id);
    return payment.status === 'NEEDS_VERIFICATION'
      ? this.#completeVerification(payment, verify, id)
      : payment;
  }

  /**
   * Withdraws from XO: confirms a withdrawal quote, claims the funding of the payment once on
   * the backend, and sends the quoted amount of XO USDC from the trading wallet to the bridge
   * provider's deposit address, in one USDC transfer. The bridge provider then delivers the
   * quoted asset to the quote's recipient.
   *
   * ```ts
   * const { quotes } = await bridge.quoteWithdraw({ asset, amount: '25', recipient });
   * const { payment, tx } = await bridge.withdraw(quotes[0]);
   * if (tx.status === 'reverted') {
   *   // Mined but failed: nothing reached the bridge. See "Money moves once" below.
   * }
   * await bridge.wait(payment.paymentId);
   * ```
   *
   * **This is the one call that moves money, and it does so at most once.** It checks
   * everything it can first, claims the funding, and only a successful claim is followed by the
   * transfer:
   *
   * 1. the quote is a withdrawal quote with an `input.amount` and the `recipient` it was asked
   *    for, the client has a signer that can sign a transaction (`signHash`), and the rail can
   *    send for this client: it exists, the sponsored rail has a `sponsorUrl` (on `mainnet` it is
   *    XO's sponsor, for a plain wallet and a smart wallet alike) and no earlier transaction of
   *    the owner may still land (two reads, the owner's `'latest'` and `'pending'` nonces: none is
   *    in the mempool, and none this process handed over is unmined), and the direct rail has an
   *    EOA (so the claim is never spent on a transfer that cannot be made, or that could pay
   *    twice);
   * 2. the quote is confirmed (`POST /payments`, once). If the bridge provider asks the owner to
   *    sign (`'NEEDS_VERIFICATION'`), the checks of step 3 that do not need the status come
   *    first: a payment that shows `fundingClaimedAt`, is another payment or does not deliver to
   *    the quote's `recipient` fails right there, before the `verify` callback is asked and
   *    before anything is signed. Only then is it verified as in {@link BridgeClient.deposit};
   * 3. the answer does not show `fundingClaimedAt` (a payment an earlier call claimed goes
   *    straight to `bridge_funding_claimed`, whatever its status, before anything below), and it
   *    is the payment you asked for, a withdrawal to the quote's `recipient` that is
   *    `'AWAITING_FUNDS'` with its deposit instructions;
   * 4. the instructions are what the quote said: on XO's own chain, for XO USDC (the environment's
   *    USDC contract), an address that is not the zero address or the USDC contract, and
   *    **exactly the quote's `input.amount`**. A server that asks for more is refused, not paid;
   * 5. the trading wallet holds at least that much USDC;
   * 6. only then the funding is claimed (`POST /payments/:id/funding-claim`, once; the backend
   *    lets exactly one claim win), and
   * 7. only after the claim answered with success, and showed the deposit instructions that were
   *    checked, one `transferUsdc` is sent. The claim's answer is read for those and nothing
   *    else, so a field it lacks cannot stop the transfer.
   *
   * Any failure up to and including step 5 leaves nothing claimed and nothing sent by this call
   * (`mayHaveLanded: false` unless the confirm itself was lost, see below), so the call can simply
   * be made again with the same quote. The exception is step 3's `bridge_funding_claimed`: an
   * earlier call claimed the funding, and may have sent the transfer. **Neither the claim nor the
   * transfer is ever repeated by the SDK.**
   *
   * **Money moves once.** After the claim, `withdraw()` cannot be used to send again: a second
   * call sends the confirm again (it is idempotent: the backend answers with the stored payment),
   * sees that the payment shows `fundingClaimedAt`, and fails with `bridge_funding_claimed` right
   * away: before the funding checks, the balance read and the claim request, so it cannot answer
   * `insufficient_balance` because the first transfer took the USDC, and it sends nothing. So when
   * the transfer fails after the claim or `tx.status` is `'reverted'`, **the claim is used** and
   * you finish the payment yourself:
   *
   * - `tx.status === 'reverted'`: the transaction was mined and failed; nothing reached the bridge.
   *   Send the amount with `account.transferUsdc(getAddress(payment.deposit.address),
   *   payment.deposit.amount)` (`getAddress` is viem's; before `payment.fundBy`), and then follow
   *   the payment.
   * - an error with `mayHaveLanded: true` (the rail did not see a receipt in 120 s, or lost the
   *   answer): the transfer may still land. **Do not send by hand yet**: a second transfer sent
   *   while the first is pending takes the next nonce and pays twice if both land. Reconcile
   *   the first as `receipt_timeout` says: has `error.transactionHash` a receipt, or has `error.nonce`
   *   been used by another transaction? Only a transaction that cannot land any more (reverted,
   *   or replaced) allows sending by hand. `get(paymentId)` shows when the bridge has the funds.
   * - an error with `mayHaveLanded: false` from the transfer itself (the rail refused it, for
   *   example): this call's transfer was not sent. Every other refusal of `withdraw()` comes
   *   before the claim, so tell them apart with `get(paymentId)`. When `fundingClaimedAt` is
   *   `null`, nothing was claimed and the call can be made again. When it is set, the claim is
   *   used, and the transfer of another call (another process, or one that crashed) may be on
   *   chain or already with the bridge: **do not send by hand from here**. Follow the steps of
   *   `bridge_funding_claimed`: go by the status (`'PROCESSING'` or `'COMPLETE'`: follow it with
   *   `wait()`; `'HALTED'`: its `recoveryUrl` is the bridge's recovery page; `'EXPIRED'`: never
   *   funded, so reconcile any transfer that may still be pending; `'TAINTED'`: report the
   *   `paymentId` to XO), and for `'AWAITING_FUNDS'` reconcile any earlier transfer and confirm
   *   the deposit instructions before you send anything.
   *
   * **The balance check is a read, not a reservation.** Step 5 reads the trading wallet's USDC at
   * one moment. Another withdrawal, a trade or a transfer that runs before the transfer is sent
   * can still leave too little: then the transfer fails after the claim, and the claim is used.
   * Keep the funds in place from the call to the end of the transfer.
   *
   * **Check the recipient before you confirm.** `quoteWithdraw` takes any recipient, and a valid
   * one that is wrong is final: the bridge delivers where the quote says.
   *
   * **Errors.** Every error carries `mayHaveLanded` and, once the quote is confirmed, the
   * `paymentId`. `bridge_funding_claimed` (`mayHaveLanded: true`) says the claim is, or may be,
   * used and this call sent nothing; `bridge_funding_mismatch` (`mayHaveLanded: false`) says what
   * the backend answered is not something the SDK will fund, and nothing was claimed or sent.
   *
   * @param quote A quote option from `quoteWithdraw`. Its `paymentId`, `direction`, `recipient`
   *   and `input.amount` are read: the amount is the most the call will send, and the confirmed
   *   payment must deliver to the recipient.
   * @param o.verify Approves each item the owner is asked to sign, as for
   *   {@link BridgeClient.deposit}. Needed only if the bridge provider asks for a verification.
   * @returns The payment as the claim answered it (or, when that answer lacks fields of the full
   *   payment, the confirmed payment with the claim's `fundingClaimedAt`), and the transfer's
   *   result.
   * @throws {UserInputError} `bridge_not_available` when the environment has no bridge;
   *   `invalid_input` for a quote that is not a withdrawal quote option (a deposit quote
   *   included) or has no usable `input.amount` or `recipient`, or for options that are wrong;
   *   `rail_not_configured`, `sponsor_not_configured` and `direct_rail_eoa_only` when the rail
   *   could not send the transfer (checked before the quote is confirmed; see also the sponsored
   *   rail's `previous_operation_pending`, under `TransactionFailedError`);
   *   `insufficient_balance` when the trading wallet holds less USDC than the amount;
   *   `signer_mismatch` and `verification_failed` as for {@link BridgeClient.deposit}. All with
   *   `mayHaveLanded: false`, nothing claimed and nothing sent. The exception is
   *   `insufficient_balance` (and a refusal of the rail): the transfer checks the balance and the
   *   rail again when it sends, after the claim, so the same error can come with the claim
   *   already used and this call's transfer not sent. `get(paymentId)` tells them apart:
   *   `fundingClaimedAt` is set once the claim is made, and then you follow the steps of
   *   `bridge_funding_claimed` (go by the status, reconcile any earlier transfer, confirm the
   *   instructions) before you send anything by hand.
   * @throws {AuthRequiredError} `auth_required` without a signer or a backend key;
   *   `verification_required` as for {@link BridgeClient.deposit}. `mayHaveLanded: false`.
   * @throws {SigningError} `sign_hash_unsupported` for a signer that cannot sign a raw digest
   *   (it could not send the transfer); `verification_payload_refused` and `signing_failed` as
   *   for {@link BridgeClient.deposit} (`signing_failed` includes a signature that does not
   *   recover to the signer). `mayHaveLanded: false`.
   * @throws {TransactionFailedError} `previous_operation_pending` or `chain_read_failed`
   *   (`mayHaveLanded: false`) from the sponsored rail's check before the quote is confirmed: an
   *   earlier transaction of the owner may still land (it is in the mempool, or this process
   *   handed it over and its nonce is not mined yet; the error has that `nonce`), or a nonce read
   *   failed. Nothing was confirmed, claimed or sent: call again once it is resolved (see
   *   `docs/errors.md`).
   *   `bridge_funding_mismatch` (`mayHaveLanded: false`): the answer is
   *   for another payment, does not deliver to the quote's `recipient` (for a payment that waits
   *   for verification, checked before anything is signed), is not an
   *   `'AWAITING_FUNDS'` withdrawal with deposit instructions (the message names the status;
   *   `withdraw({ quote })` may be retried, as confirming is idempotent), or its instructions differ
   *   from the quote. Nothing was claimed or sent.
   *   `bridge_funding_claimed` (`mayHaveLanded: true`): the funding was already claimed (the
   *   confirmed payment shows `fundingClaimedAt`, which is what a repeated call gets, before the
   *   funding checks, the balance read and the claim request; the backend answered 409
   *   `funding_already_claimed`; or it answered 409 `payment_not_awaiting_funds` and the payment,
   *   read once after it, shows `fundingClaimedAt`: another call claimed it, and may have funded
   *   it), or the claim request failed after it may have reached the
   *   backend (a timeout, a lost connection, a 5xx, an answer that did not show the claim); this
   *   call sent nothing, and `get(paymentId)` says where the payment is. An earlier call's
   *   transfer may be on chain: reconcile it before you send by hand. It is also what the call
   *   raises when the claim worked but its answer showed deposit instructions other than the
   *   ones checked before the claim: the SDK refuses to send to those, so nothing was sent, and
   *   **you confirm the payment's instructions with `get(paymentId)` (XO's chain, XO USDC,
   *   exactly the quoted amount) before you send anything yourself**. For every cause, reconcile
   *   any earlier transfer before you send by hand, as above.
   *   `send_failed` with `mayHaveLanded: false` and no `paymentId`: a check of the rail before
   *   the quote was confirmed (its identity could not be resolved, say) failed with something
   *   that is not an SDK error; nothing was confirmed, claimed or sent. After the claim, an
   *   error that is not an SDK error is `send_failed` with `mayHaveLanded: true`. The rail's own
   *   errors (`receipt_timeout` and the others of the transfer) come out unchanged, with the
   *   `paymentId` added.
   * @throws {RequestRejectedError} Status 409, `quote_expired` (the quote can no longer be confirmed) and
   *   `payment_not_awaiting_verification`: `mayHaveLanded: false`, nothing claimed.
   *   `payment_not_awaiting_funds`: the backend refused this call's claim because the payment
   *   cannot be funded now (it is not waiting for funds, or its deadline is within 10 minutes),
   *   and the payment read after it showed no claim, or could not be read. `mayHaveLanded:
   *   false`: this call claimed and sent nothing. That does not prove nobody did: **read
   *   `get(paymentId)` first**, and go by its status. `'PROCESSING'` or `'COMPLETE'`: another
   *   call funded it, so follow it with `wait()`. `'HALTED'`: it may still finish, and its
   *   `recoveryUrl` is the bridge's recovery page. `'EXPIRED'`: it was never funded, so send
   *   nothing, and reconcile any transfer that may still be pending. `'TAINTED'`: report the
   *   `paymentId` to XO. `'AWAITING_FUNDS'` with `fundingClaimedAt` set: the steps of
   *   `bridge_funding_claimed`; with it `null`, nothing was claimed: ask for a new quote.
   * @throws {RequestRejectedError} Status 404, `payment_not_found`. `mayHaveLanded: false`.
   * @throws {XoError} `session_closed` (`mayHaveLanded: false`) when the client was closed
   *   (`xo.close()`). Before the confirm nothing was confirmed, claimed or sent; if the client
   *   was closed while the call ran, the transfer can be refused the same way after the claim,
   *   and then the claim is used: tell them apart with `get(paymentId)`, as above.
   * @throws {RequestRejectedError} Status 5xx, `bridge_unavailable`, `bridge_rejected` and other
   *   server failures of the confirm or the verification, a {@link TimeoutError}, a
   *   {@link TransportError} or an {@link UnexpectedResponseError}: `mayHaveLanded: true`, and
   *   nothing was claimed or sent.
   *   `get(paymentId)` shows the payment; the same quote can be passed to `withdraw` again.
   */
  async withdraw(
    quote: BridgeQuote,
    o: { verify?: VerifyCallback } = {},
  ): Promise<BridgeWithdrawal> {
    assertBridgeAvailable(this.#deps.env);
    const id = readQuoteOption(quote, 'withdraw');
    const quotedMicro = readQuotedMicro(quote);
    const recipient = readQuoteRecipient(quote);
    const verify = readVerifyOption(o, false);
    await this.#assertCanSend();
    // The confirm may be repeated by the caller (the backend answers with the stored payment);
    // the claim and the transfer may not, and nothing below repeats either.
    let payment = await this.#confirm(id);
    if (payment.status === 'NEEDS_VERIFICATION') {
      // Before the owner is asked to sign anything: a claimed payment goes to the reconcile
      // steps, and one that is not the quote's withdrawal (another payment, another recipient)
      // is never verified, let alone funded.
      assertFundingNotClaimed(payment, id);
      assertWithdrawalOfQuote(payment, { paymentId: id, recipient });
      payment = await this.#completeVerification(payment, verify, id);
    }
    // A payment whose funding is already claimed is for the reconcile steps, never for another
    // claim or transfer: checked before the funding target, the balance and the claim.
    assertFundingNotClaimed(payment, id);
    const target = await this.#checkBeforeClaim(payment, id, {
      quotedMicro,
      recipient,
    });
    const claimed = await this.#claim(id, payment, target);
    return { payment: claimed, tx: await this.#transfer(target, id) };
  }

  /**
   * Finishes the verification of a payment that is waiting for the owner's signatures: the
   * way to complete a `deposit` that failed with `verification_required`, or a payment whose
   * verification you want to handle apart from the confirm.
   *
   * It reads the payment (`get(paymentId)`). If it is `'NEEDS_VERIFICATION'`, it runs the same
   * verification as {@link BridgeClient.deposit} does: every item is decoded and checked first,
   * your `verify` callback approves each in turn, and only then is anything signed and sent.
   * **If the payment is in any other status it is returned as it is: nothing is asked, signed or
   * sent.** So it is safe to call again.
   *
   * @param paymentId The id of the payment, as `error.paymentId` or `quote.paymentId` has it.
   * @param o.verify Approves each item the owner is asked to sign. Required.
   * @throws {UserInputError} `bridge_not_available` when the environment has no bridge;
   *   `invalid_input` when `paymentId` is not 1 to 128 letters, digits, underscores or hyphens or
   *   when `o.verify` is missing or not a function, with nothing sent; the errors of
   *   {@link BridgeClient.deposit} for the verification itself.
   * @throws {RequestRejectedError} Status 404, `payment_not_found`.
   * @throws {AuthRequiredError} `auth_required`, `verification_required`.
   * @throws {SigningError} `verification_payload_refused`, `signing_failed` (a signer that
   *   threw, or a signature that does not recover to the signer's address).
   * @throws {RequestRejectedError} Status 5xx, as {@link BridgeClient.deposit}: the read has
   *   `mayHaveLanded: false`, the verification POST has `true` for a server failure, a timeout
   *   or a lost connection. Every error carries the `paymentId`.
   */
  async verify(
    paymentId: string,
    o: { verify: VerifyCallback },
  ): Promise<BridgePayment> {
    assertBridgeAvailable(this.#deps.env);
    const id = readPaymentId(paymentId);
    const verify = readVerifyOption(o, true);
    const payment = await this.get(id);
    return payment.status === 'NEEDS_VERIFICATION'
      ? this.#completeVerification(payment, verify, id)
      : payment;
  }

  /**
   * One payment by its id: a deposit or a withdrawal at any point of its life, or a quote
   * option nobody has confirmed (`'QUOTED'`). It is the way to find out where a payment is
   * after a failure, and `status` says what to do next.
   *
   * Every error of the request carries the `paymentId`, and `mayHaveLanded: false`: a read
   * moves nothing. A read that fails because of the network or the service is retried like any
   * read.
   *
   * @param paymentId The id of a quote option or a payment.
   * @throws {UserInputError} `bridge_not_available` when the environment has no bridge;
   *   `invalid_input` when `paymentId` is not 1 to 128 letters, digits, underscores or hyphens.
   *   Nothing sent.
   * @throws {RequestRejectedError} Status 404, `payment_not_found`: no payment of this account has that id.
   * @throws {AuthRequiredError} Without a signer or a backend key: nothing sent.
   */
  async get(paymentId: string, call?: CallOptions): Promise<BridgePayment> {
    assertBridgeAvailable(this.#deps.env);
    const id = readPaymentId(paymentId);
    return this.#readPayment(id, { call });
  }

  /**
   * Waits until a payment is final, polling it every 10 seconds, and returns it. Use it after
   * you sent the funds of a deposit, or after `withdraw`, to follow the payment to its end.
   *
   * ```ts
   * const payment = await bridge.wait(paymentId, {
   *   timeoutMs: 30 * 60_000,
   *   onUpdate: (p) => console.log(p.status),
   * });
   * if (payment.status !== 'COMPLETE') {
   *   // 'EXPIRED' or 'TAINTED': the payment ended without delivering.
   * }
   * ```
   *
   * **It resolves with a final payment, which is not always a success.** The final statuses are
   * `'COMPLETE'` (delivered), `'EXPIRED'` (not funded in time) and `'TAINTED'` (the bridge will
   * not complete it): check `status`. Every other status, `'HALTED'` included (it may still
   * finish), is waited out, and so is a status this SDK version does not know.
   *
   * **The loop.** It reads the payment (`get`); calls `onUpdate` if the status differs from the
   * last one it saw (always at the first read); returns the payment if it is final; fails if the
   * deadline has passed; otherwise sleeps 10 seconds, or what remains of the time if that is
   * less, and reads again. So a wait that times out makes one last read at its deadline. The
   * deadline is counted from the call with the system clock (`Date.now`), and is checked
   * between reads: a read in flight is not cut at the deadline, and ends by its own request
   * timeout and retries, so a wait can end a request later than `timeoutMs`.
   *
   * **A failed read is not the end.** A read that fails because the service is down or limiting
   * (a `RequestRejectedError` with a 5xx status, `RateLimitError`), because a request timed out (`TimeoutError`)
   * or because no answer came (`TransportError`) is ridden out: the next poll reads again, for
   * as long as the deadline allows. Anything else ends the wait at once with that error: a
   * 404 `payment_not_found`, a 401, an answer the schema refuses, a
   * closed client. If the deadline passes while reads keep failing, the `bridge_wait_timeout`
   * error has the last failure as its `cause`.
   *
   * **Ending it from outside.** Pass a `signal` to stop a wait: it rejects with `signal.reason`
   * as it is, at once when it is sleeping, and at once when a read is in flight (the request is
   * cancelled). A signal that is already aborted rejects before anything is sent. An `onUpdate`
   * that is running when it aborts is awaited, not stopped: the wait ends once it settles, and
   * what the callback started is the callback's to cancel (pass it the same signal). Closing the
   * client ends the wait too, with `session_closed`, but only at the next poll (up to 10
   * seconds later, the sleep is not cut): use a `signal` to end it sooner. However it ends, the
   * wait leaves no timer or listener behind, so a process can exit.
   *
   * **It never sends anything but reads.** Waiting does not confirm, fund, claim or sign, and
   * it is safe to call again, from another process too, for the same payment. Every error
   * raised after the arguments were checked carries the `paymentId`, except the `signal`'s
   * reason, which is yours and comes out as it is.
   *
   * @param paymentId The id of the payment, as `quote.paymentId` or `error.paymentId` has it.
   * @param o.timeoutMs How long to wait, from the call. Default one hour, at most 24 hours.
   * @param o.signal Ends the wait early; it rejects with the signal's reason.
   * @param o.onUpdate Called with the payment at the first read and on each change of status.
   *   If it throws or rejects, the wait stops: an `XoError` leaves `wait` with the `paymentId`
   *   added and `mayHaveLanded: false` (unless it already says), and anything else leaves as
   *   `bridge_wait_callback_failed` with the original as `cause`. A rejection with the
   *   `signal`'s own reason, once it aborted, leaves as that reason.
   * @returns The payment, in `'COMPLETE'`, `'EXPIRED'` or `'TAINTED'`.
   * @throws {UserInputError} `bridge_not_available` when the environment has no bridge;
   *   `invalid_input` when `paymentId` is not 1 to 128 letters, digits, underscores or hyphens,
   *   or an option is unknown or of the wrong kind (`timeoutMs` above 0 and at most 24 hours,
   *   `signal` an `AbortSignal`, `onUpdate` a function). Both with `mayHaveLanded: false`, and
   *   nothing sent.
   * @throws {TimeoutError} `bridge_wait_timeout`, with `mayHaveLanded: true` and the `paymentId`:
   *   the payment was not final in time. The payment goes on: read it with `get(paymentId)`, or
   *   wait for it again.
   * @throws {RequestRejectedError} Status 404, `payment_not_found`: no payment of this account has that id.
   * @throws {AuthRequiredError} Without a signer or a backend key: nothing sent.
   * @throws {XoError} `session_closed` when the client was closed; `bridge_wait_callback_failed`
   *   (`mayHaveLanded: false`, the original in `cause`) when `onUpdate` threw something that is
   *   not an `XoError`. Other errors of a read, with `mayHaveLanded: false`, as for `get`.
   * @throws The `signal`'s reason, whatever it is, when the signal aborts.
   */
  async wait(
    paymentId: string,
    o: BridgeWaitOptions = {},
  ): Promise<BridgePayment> {
    assertBridgeAvailable(this.#deps.env);
    const id = readPaymentId(paymentId);
    const { timeoutMs, signal, onUpdate } = readWaitOptions(o);
    const deadline = Date.now() + timeoutMs;
    let seen: string | undefined;
    let latest: BridgePayment | undefined;
    for (;;) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const answer = await this.#poll(id, signal);
      // A transient failure is no answer: the payment may have moved on, the next poll will see.
      let failure: XoError | undefined;
      if (answer instanceof XoError) {
        failure = answer;
      } else {
        latest = answer;
        if (answer.status !== seen) {
          seen = answer.status;
          await this.#notify(onUpdate, answer, id, signal);
        }
        if (isFinalStatus(answer.status)) {
          return answer;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw waitTimedOut(id, timeoutMs, latest, failure);
      }
      await sleep(Math.min(BRIDGE_POLL_MS, remaining), signal);
    }
  }

  /**
   * The account's deposits and withdrawals, newest first, as a lazy `Paginator`: nothing is
   * requested until it is read, and every read starts again from the first page. It asks for
   * 100 payments per page. A quote nobody confirmed is not history, so the list holds none.
   *
   * ```ts
   * for await (const payment of bridge.history({ direction: 'withdraw' })) {
   *   console.log(payment.paymentId, payment.status);
   * }
   * ```
   *
   * The options are checked, and the gate passed, when `history()` is called; the credentials
   * are checked when the first page is requested. An error of a page has `mayHaveLanded: false`.
   *
   * @param o.direction Only deposits (`'deposit'`) or only withdrawals (`'withdraw'`).
   * @param o.status Only payments in this status. `'QUOTED'` is refused.
   * @param call The per-call options of each page's request.
   * @param start The cursor of the page to start at, as an answer gave it; the first page
   *   without it.
   * @throws {UserInputError} `bridge_not_available` when the environment has no bridge;
   *   `invalid_input` for an unknown option, a `direction` that is neither, or a `status`
   *   that is empty or `'QUOTED'`. Nothing sent.
   */
  history(
    o: BridgeHistoryOptions = {},
    call?: CallOptions,
    start?: string,
  ): Paginator<BridgePayment> {
    assertBridgeAvailable(this.#deps.env);
    const { direction, status } = readHistoryOptions(o);
    const fetchPage = (cursor: string | undefined) =>
      bridgeRequest(this.#deps, {
        method: 'GET',
        path: `${BRIDGE_BASE}/payments`,
        query: { direction, status, cursor, limit: HISTORY_PAGE_SIZE },
        schema: BridgePaymentPageSchema,
        call,
      });
    // `start` resumes the walk at a cursor a page gave out; without it the walk starts at the
    // first page.
    return cursorPaginator(async (cursor) => {
      const raw = await fetchPage(cursor);
      return { data: raw.data, next_cursor: raw.nextCursor ?? '', raw };
    }, start);
  }

  /**
   * One read of the payment `id` (`GET /payments/:id`), with read retries. Every error carries
   * the `paymentId` and, as a read, `mayHaveLanded: false`. `signal` cancels the request;
   * `call` carries the caller's per-call options.
   */
  async #readPayment(
    id: string,
    o: { signal?: AbortSignal; call?: CallOptions } = {},
  ): Promise<BridgePayment> {
    try {
      return await bridgeRequest(this.#deps, {
        method: 'GET',
        path: `${BRIDGE_BASE}/payments/${id}`,
        schema: BridgePaymentSchema,
        signal: o.signal,
        call: o.call,
      });
    } catch (error) {
      throw error instanceof XoError ? withPaymentId(error, id) : error;
    }
  }

  /**
   * One poll of {@link BridgeClient.wait}: the payment, or the transient error that stopped the
   * read ({@link isTransientRead}), returned and not thrown. An abort of `signal` is thrown as
   * `signal.reason` whatever form it took on the way up (the transport raises its own error for
   * a request it cancelled); every other failure is thrown as it is, with the `paymentId`.
   */
  async #poll(
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<BridgePayment | XoError> {
    try {
      return await this.#readPayment(id, { signal });
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason;
      }
      if (isTransientRead(error)) {
        return error;
      }
      throw error;
    }
  }

  /**
   * Calls the `onUpdate` of {@link BridgeClient.wait} and waits for what it returns. What it
   * throws (or rejects with) ends the wait, and leaves as an error with the `paymentId` and
   * `mayHaveLanded: false` (the callback moved nothing):
   *
   * - the caller's own abort reason (`signal` has aborted and the callback threw that very
   *   `signal.reason`, as a callback awaiting a `fetch` with the same signal does) as it is,
   *   with no flag and no `paymentId`: the reason is the caller's, as everywhere else in `wait`;
   * - an `XoError` as it is (it keeps a `mayHaveLanded` it already has);
   * - anything else, an `Error` or any other value, as `bridge_wait_callback_failed`, an
   *   `XoError` that names only the thrown value's class and has the original as its `cause`.
   */
  async #notify(
    onUpdate: ((payment: BridgePayment) => void) | undefined,
    payment: BridgePayment,
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      await onUpdate?.(payment);
    } catch (error) {
      if (signal?.aborted && error === signal.reason) {
        throw error;
      }
      throw withPaymentId(
        withLanded(
          error instanceof XoError
            ? error
            : new XoError(
                `The onUpdate callback failed (${errorName(error)}) while waiting for payment ${id}, so the wait stopped. The payment goes on and nothing was sent: read it with fetchBridgePayment({ paymentId: "${id}" }), or wait for it again`,
                {
                  code: 'bridge_wait_callback_failed',
                  service: 'sdk',
                  cause: error,
                },
              ),
          false,
        ),
        id,
      );
    }
  }

  /**
   * Sends one quote request and shapes the answer: every option gets the request's `direction`
   * (and, for a withdrawal, its `recipient`) and the answer's `acceptBy`, and the options are
   * sorted by `output.amount`, largest first.
   * Without `call` the request is a POST and goes out once. Its errors leave classified by
   * {@link landedAfterPost}: a 4xx is a refusal (`mayHaveLanded: false`), anything else may
   * have stored quote rows. With `call` it is a read: retried with the call's options, and its
   * errors have `mayHaveLanded: false`, since a quote moves nothing.
   */
  async #quote(body: QuoteBody, call?: CallOptions): Promise<BridgeQuotes> {
    const read = call !== undefined;
    const answer = await bridgeRequest(this.#deps, {
      method: 'POST',
      path: `${BRIDGE_BASE}/quotes`,
      body,
      schema: BridgeQuotesSchema,
      ...(read ? { call, read } : {}),
    }).catch((error: unknown) => {
      throw error instanceof XoError
        ? withLanded(error, read ? false : landedAfterPost(error))
        : error;
    });
    const { quotes, acceptBy, limits } = answer.data;
    // A withdrawal quote keeps the recipient it was asked for: withdraw() checks the payment
    // against it.
    const recipient =
      body.recipient === undefined ? {} : { recipient: body.recipient };
    return {
      quotes: quotes
        .map((quote) => ({
          ...quote,
          direction: body.direction,
          acceptBy,
          ...recipient,
        }))
        .sort((a, b) => compareDecimal(b.output.amount, a.output.amount)),
      acceptBy,
      limits,
    };
  }

  /**
   * Confirms the quote option `id` (`POST /payments`). The request goes out once. Its errors
   * leave classified by {@link landedAfterPost} (a 4xx, such as `quote_expired`, is a refusal;
   * anything else may have confirmed it) and carry the payment id. Withdrawals confirm the same
   * way.
   */
  async #confirm(id: string): Promise<BridgePayment> {
    try {
      return await bridgeRequest(this.#deps, {
        method: 'POST',
        path: `${BRIDGE_BASE}/payments`,
        body: { paymentId: id },
        schema: BridgePaymentSchema,
      });
    } catch (error) {
      throw error instanceof XoError
        ? withPaymentId(withLanded(error, landedAfterPost(error)), id)
        : error;
    }
  }

  /**
   * The checks of `withdraw` that need no request to a bridge service, made before the quote is
   * confirmed, so the one-time funding claim is never spent on a transfer that cannot be made:
   *
   * 1. a signer must be present, and it must be able to sign a transaction (`signHash`, which
   *    the rail needs);
   * 2. the account client's rail must be able to send for this client: there is a rail
   *    (`rail_not_configured`), the sponsored rail has a `sponsorUrl` (`sponsor_not_configured`),
   *    the direct rail has an EOA (`direct_rail_eoa_only`), the client is open, and the signer
   *    is the owner. On the sponsored rail, its two nonce reads too: an earlier transaction of
   *    the owner that may still land (`previous_operation_pending`). These are the refusals
   *    `transferUsdc` would make (or, for an earlier transaction that may still land, the double
   *    payment it could make), but only after the claim.
   *
   * Nothing is confirmed, claimed or sent; every error has `mayHaveLanded: false`.
   */
  async #assertCanSend(): Promise<void> {
    const signer = this.#signer;
    if (signer === undefined) {
      throw withLanded(
        new AuthRequiredError(
          "withdraw() sends USDC from the trading wallet, which needs the owner's signer: create the client with a signer. Nothing was sent",
        ),
        false,
      );
    }
    if (typeof signer.signHash !== 'function') {
      throw withLanded(
        new SigningError(
          'withdraw() sends a transaction, which needs a signer that can sign a raw 32-byte digest (signHash), and wallet clients (browser or hardware wallets) cannot: use privateKey or signerFrom with a local account. Nothing was sent',
          { code: 'sign_hash_unsupported' },
        ),
        false,
      );
    }
    try {
      await preflightSend(this.#account, 'withdraw() sends USDC');
    } catch (error) {
      throw error instanceof XoError ? withLanded(error, false) : error;
    }
  }

  /**
   * Everything `withdraw` can check before it claims the funding: that the payment is fundable
   * as the quote said ({@link readFundingTarget}, which also checks the payment is the one asked
   * for and delivers to the quote's recipient), and that the trading wallet holds the amount (a
   * claim spent on a wallet that cannot pay would need a manual recovery). Returns where to
   * send the USDC. Every error leaves with `mayHaveLanded: false` and the `paymentId`: nothing has
   * been claimed or sent.
   */
  async #checkBeforeClaim(
    payment: BridgePayment,
    id: string,
    quoted: { quotedMicro: bigint; recipient: string },
  ): Promise<FundingTarget> {
    try {
      const { usdc } = this.#deps.env.contracts;
      const target = readFundingTarget(payment, {
        paymentId: id,
        usdc,
        ...quoted,
      });
      const identity = await this.#identity();
      const holder = normalizeAddress(identity.address, 'identity.address');
      const balance = await readUsdcBalance(this.#chain, usdc, holder);
      if (balance < target.micro) {
        throw new UserInputError(
          `The USDC balance of ${holder} is ${fromMicro(balance)}, less than the ${fromMicro(target.micro)} to withdraw: nothing was claimed or sent`,
          { code: 'insufficient_balance' },
        );
      }
      return target;
    } catch (error) {
      throw error instanceof XoError
        ? withPaymentId(withLanded(error, false), id)
        : error;
    }
  }

  /**
   * Claims the funding of the withdrawal `id` (`POST /payments/:id/funding-claim`, no body). The
   * request goes out once. A claim is one-time and the transfer comes after it, so the answer is
   * read for only what `withdraw` needs ({@link BridgeFundingClaimSchema}), and a field it does
   * not read can never fail it. What it classifies:
   *
   * - a success that is another payment, that does not show the claim (`fundingClaimedAt`), or
   *   whose deposit instructions are not the ones that were checked (`target`), is ambiguous;
   * - `funding_already_claimed`, and every failure that may have reached the backend (a 5xx, a
   *   timeout, a lost connection, an unreadable 2xx: {@link landedAfterPost}) are
   *   `bridge_funding_claimed`, `mayHaveLanded: true`: the claim may be used, so nothing is
   *   sent;
   * - `payment_not_awaiting_funds` is read for what it hides: the backend answers it for a
   *   payment that another call claimed and funded (it is `PROCESSING` by then), so the payment is
   *   read once ({@link BridgeClient.#claimedMeanwhile}). When it shows `fundingClaimedAt`, the
   *   error is `bridge_funding_claimed` (`mayHaveLanded: true`, the 409 as its cause); when it
   *   does not, or the read fails, the 409 comes out as it was;
   * - any other refusal (a 4xx such as `not_a_withdrawal`) is that error with
   *   `mayHaveLanded: false`: this claim was not made.
   *
   * Every error carries the `paymentId`. It returns the payment the claim answered, or, when
   * that answer lacks a field of the full payment, the confirmed `payment` with the claim's
   * `fundingClaimedAt`.
   */
  async #claim(
    id: string,
    payment: BridgePayment,
    target: FundingTarget,
  ): Promise<BridgePayment> {
    let answer: BridgeFundingClaim;
    try {
      answer = await bridgeRequest(this.#deps, {
        method: 'POST',
        path: `${BRIDGE_BASE}/payments/${id}/funding-claim`,
        schema: BridgeFundingClaimSchema,
      });
    } catch (error) {
      if (
        error instanceof XoError &&
        error.code === 'funding_already_claimed'
      ) {
        throw fundingClaimed(id, 'was already claimed', error);
      }
      if (landedAfterPost(error)) {
        throw fundingClaimed(
          id,
          'may have been claimed, because the claim request failed after it could have reached the backend',
          error,
        );
      }
      if (!(error instanceof XoError)) {
        throw error;
      }
      const refusal = withPaymentId(withLanded(error, false), id);
      if (
        refusal.code === 'payment_not_awaiting_funds' &&
        (await this.#claimedMeanwhile(id))
      ) {
        throw fundingClaimed(
          id,
          'was claimed by another call: the claim was refused because the payment is no longer waiting for funds, and the payment shows fundingClaimedAt',
          refusal,
        );
      }
      throw refusal;
    }
    if (answer.paymentId !== id || !answer.fundingClaimedAt) {
      throw fundingClaimed(
        id,
        'may have been claimed, because the answer to the claim does not show it',
      );
    }
    if (
      !claimShowsDeposit(answer.deposit, target, this.#deps.env.contracts.usdc)
    ) {
      throw fundingClaimedOtherInstructions(id);
    }
    const full = BridgePaymentSchema.lenient.safeParse(answer);
    return full.success
      ? full.data
      : { ...payment, fundingClaimedAt: answer.fundingClaimedAt };
  }

  /**
   * After the claim of `id` was refused with `payment_not_awaiting_funds`: one read of the
   * payment, `true` when it shows `fundingClaimedAt` (another call claimed the funding, and may
   * have sent the transfer). A read that fails, or answers for another payment, says nothing:
   * `false`, and the refusal comes out as it was.
   */
  async #claimedMeanwhile(id: string): Promise<boolean> {
    try {
      const payment = await this.#readPayment(id);
      return (
        payment.paymentId === id && typeof payment.fundingClaimedAt === 'string'
      );
    } catch {
      return false;
    }
  }

  /**
   * Sends the one USDC transfer of a claimed withdrawal through the account client, which checks
   * the recipient, the balance and the rail again, and never repeats. Its errors come out
   * unchanged, with the `paymentId` added: they carry `mayHaveLanded` and `transactionHash` already. An
   * `XoError` that somehow has no flag gets `true`, and anything that is not an `XoError`
   * becomes `TransactionFailedError` `send_failed` with `true` and no cause (a raw error can hold what
   * it should not): the claim is used, so nothing is known about the transfer.
   */
  async #transfer(target: FundingTarget, id: string): Promise<TxResult> {
    try {
      return await this.#account.transferUsdc(target.address, target.amount);
    } catch (error) {
      if (error instanceof XoError) {
        throw withPaymentId(withLanded(error, true), id);
      }
      throw withPaymentId(
        new TransactionFailedError(
          `The transfer of payment ${id} failed unexpectedly (${errorName(error)}) after its funding was claimed, so it may have been sent: do not call withdraw() again, it cannot send twice. Read the payment with fetchBridgePayment({ paymentId: "${id}" }) and reconcile the transfer before sending by hand`,
          { code: 'send_failed', mayHaveLanded: true },
        ),
        id,
      );
    }
  }

  /**
   * Signs what a payment in `'NEEDS_VERIFICATION'` asks the owner to sign, if `verify` approves
   * it, and sends the signatures (`POST /payments/:id/verification`) once. Returns the payment
   * the backend answers with. `requestedId` is the id the caller asked for (the quote's, or the
   * argument of `verify`): the payment must be that one, so what the callback is shown and what
   * is signed belong to the payment the caller meant. In this order:
   *
   * 1. the payment's id is `requestedId` (`SigningError` `verification_payload_refused`);
   * 2. a signer is required (`AuthRequiredError`, code `auth_required`);
   * 3. the signer must be the payment's owner (`UserInputError` `signer_mismatch`);
   * 4. every item is decoded and checked, before the callback is asked about any
   *    (`SigningError` `verification_payload_refused`);
   * 5. no callback, a callback that throws, or one that does not answer `true` for an item is
   *    `AuthRequiredError` `verification_required`; the first of these stops;
   * 6. only now is anything signed, each signature is checked to recover to the signer, and then
   *    the signatures are sent.
   *
   * Everything before the POST leaves with `mayHaveLanded: false` and the `paymentId`; so does a
   * 4xx of the POST (including 422 `verification_failed`), and any other failure of the POST
   * has `true`. The signatures are never resent and the payment is never refreshed.
   */
  async #completeVerification(
    payment: BridgePayment,
    verify: VerifyCallback | undefined,
    requestedId: string,
  ): Promise<BridgePayment> {
    const id = requestedId;
    let signatures: { reason: string; signatureType: string; signature: Hex }[];
    try {
      if (payment.paymentId !== id) {
        throw payloadRefused(id, 'the answer is for another payment');
      }
      signatures = await this.#approveAndSign(payment, id, verify);
    } catch (error) {
      throw error instanceof XoError
        ? withPaymentId(withLanded(error, false), id)
        : error;
    }
    try {
      return await bridgeRequest(this.#deps, {
        method: 'POST',
        path: `${BRIDGE_BASE}/payments/${id}/verification`,
        body: { signatures },
        schema: BridgePaymentSchema,
      });
    } catch (error) {
      throw error instanceof XoError
        ? withPaymentId(withLanded(error, landedAfterPost(error)), id)
        : error;
    }
  }

  /** Steps 2 to 6 of {@link BridgeClient.#completeVerification} before the POST: the signatures to send. */
  async #approveAndSign(
    payment: BridgePayment,
    id: string,
    verify: VerifyCallback | undefined,
  ): Promise<{ reason: string; signatureType: string; signature: Hex }[]> {
    const signer = this.#signer;
    if (signer === undefined) {
      throw new AuthRequiredError(
        `Payment ${id} asks the owner to sign, and this client has no signer: create the client with a signer to verify it`,
      );
    }
    if (
      payment.ownerAddress === null ||
      !isSameAddress(payment.ownerAddress, signer.address)
    ) {
      throw new UserInputError(
        `The signer is not the owner of payment ${id}: only the owner wallet can sign its verification`,
        { code: 'signer_mismatch' },
      );
    }
    const { address: tradingAddress } = await this.#identity();
    const requests = decodeVerificationItems(payment.verification?.items, {
      paymentId: id,
      env: this.#deps.env,
      tradingAddress,
      signerAddress: signer.address,
    });
    if (verify === undefined) {
      throw verificationRequired(
        `Payment ${id} needs the owner to sign ${requests.length} item${requests.length === 1 ? '' : 's'} and no verify callback was given: nothing was signed. Pass { verify } to createDeposit(), or finish it with verifyBridgePayment({ paymentId: "${id}", verify })`,
      );
    }
    for (const [index, request] of requests.entries()) {
      const item = `item ${index + 1} of ${requests.length} of payment ${id}`;
      let approved: unknown;
      try {
        approved = await verify(request);
      } catch (error) {
        // A callback that fails has not approved: the throw is the cause, and nothing is signed.
        throw verificationRequired(
          `The verify callback threw (${errorName(error)}) on ${item}: nothing was signed. The payment still waits; finish it with verifyBridgePayment({ paymentId: "${id}", verify })`,
          error,
        );
      }
      if (approved !== true) {
        throw verificationRequired(
          `The verify callback did not approve ${item}: nothing was signed. The payment still waits; finish it with verifyBridgePayment({ paymentId: "${id}", verify })`,
        );
      }
    }
    const signatures = [];
    for (const request of requests) {
      signatures.push({
        reason: request.reason,
        signatureType: request.signatureType,
        signature: await signRequest(signer, request),
      });
    }
    return signatures;
  }
}
