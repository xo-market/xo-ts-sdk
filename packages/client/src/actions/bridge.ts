import { z } from 'zod';
import { withLanded } from '../account/internal';
import { withPaymentId } from '../bridge/internal';
import type { BridgeQuote as RawBridgeQuote } from '../bridge/schemas';
import type { VerifyCallback } from '../bridge/verification';
import type { ActionContext } from '../clients/context';
import {
  AuthRequiredError,
  makeErrorGuard,
  RateLimitError,
  RequestAbortedError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import { type Paginated, toPaginated } from '../core/paginated';
import {
  parseRequestOptions,
  type RequestOptions,
} from '../core/requestOptions';
import { singlePage } from '../data/pages';
import { minedTransactionHandle } from '../models/account';
import {
  type BridgeAsset,
  type BridgeDirection,
  type BridgePayment,
  type BridgePaymentStatus,
  type BridgeWithdrawal,
  type DepositQuote,
  toBridgeAsset,
  toBridgePayment,
  toDepositQuote,
  toWithdrawalQuote,
  type WithdrawalQuote,
} from '../models/bridge';
import {
  abortedBy,
  fields,
  noCursor,
  openForSend,
  parseInput,
  parseSendInput,
  secureOf,
} from './internal';

// Deposits into XO and withdrawals out of it. A deposit is paid in any token the bridge takes
// and lands as USDC in the trading wallet; a withdrawal sends USDC from the trading wallet and
// delivers any token the bridge offers, to any address.
//
// The quotes and the reads of payments are reads: they take the options of a read and are
// retried like one. Creating a deposit, withdrawing and verifying are sent once and take no
// options. A withdrawal moves money once: it claims the payment's funding and sends the USDC,
// and neither is ever repeated; an error after which money may have moved says
// `mayHaveLanded: true`, with the `paymentId` (and the transfer's `transactionHash`, or its
// `nonce`) to look it up by.

export type {
  VerificationRequest,
  VerifyCallback,
} from '../bridge/verification';

/**
 * The error union of the bridge's reads: the request and options, the client's sign-in
 * (`SigningError`, `client_closed`), a read that was cancelled, timed out or refused (such as a
 * quote's `asset_not_supported` or `amount_out_of_range`, or a payment's `payment_not_found`),
 * and an answer that cannot be read. A read moves nothing: its errors have `mayHaveLanded:
 * false`, but for the end of a wait (`bridge_wait_timeout`), which says `true` because the
 * payment goes on.
 */
export type BridgeReadError =
  | UserInputError
  | AuthRequiredError
  | SigningError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | RequestAbortedError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link BridgeReadError}. */
export const BridgeReadError = makeErrorGuard(
  UserInputError,
  AuthRequiredError,
  SigningError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  RequestAbortedError,
  UnexpectedResponseError,
  XoError,
);

/**
 * The error union of the bridge's sends: a deposit, a withdrawal or a verification. Each error
 * says with `mayHaveLanded` whether something may have happened, and carries the `paymentId`
 * once the quote is confirmed; a {@link TransactionFailedError} is the withdrawal's transfer.
 */
export type BridgeSendError =
  | UserInputError
  | AuthRequiredError
  | SigningError
  | TransactionFailedError
  | RequestRejectedError
  | RateLimitError
  | TimeoutError
  | TransportError
  | UnexpectedResponseError
  | XoError;
/** The guard of {@link BridgeSendError}. */
export const BridgeSendError = makeErrorGuard(
  UserInputError,
  AuthRequiredError,
  SigningError,
  TransactionFailedError,
  RequestRejectedError,
  RateLimitError,
  TimeoutError,
  TransportError,
  UnexpectedResponseError,
  XoError,
);

/** The error union of {@link SecureClient.listBridgeAssets}: see {@link BridgeReadError}. */
export type ListBridgeAssetsError = BridgeReadError;
/** The guard of {@link ListBridgeAssetsError}. */
export const ListBridgeAssetsError = BridgeReadError;
/** The error union of {@link SecureClient.quoteDeposit}: see {@link BridgeReadError}. */
export type QuoteDepositError = BridgeReadError;
/** The guard of {@link QuoteDepositError}. */
export const QuoteDepositError = BridgeReadError;
/** The error union of {@link SecureClient.quoteWithdrawal}: see {@link BridgeReadError}. */
export type QuoteWithdrawalError = BridgeReadError;
/** The guard of {@link QuoteWithdrawalError}. */
export const QuoteWithdrawalError = BridgeReadError;
/** The error union of {@link SecureClient.fetchBridgePayment}: see {@link BridgeReadError}. */
export type FetchBridgePaymentError = BridgeReadError;
/** The guard of {@link FetchBridgePaymentError}. */
export const FetchBridgePaymentError = BridgeReadError;
/**
 * The error union of {@link SecureClient.waitForBridgePayment}: those of a read, and a `TimeoutError`
 * `bridge_wait_timeout` when the payment was not final in time.
 */
export type WaitForBridgePaymentError = BridgeReadError;
/** The guard of {@link WaitForBridgePaymentError}. */
export const WaitForBridgePaymentError = BridgeReadError;
/** The error union of {@link SecureClient.listBridgePayments}: see {@link BridgeReadError}. */
export type ListBridgePaymentsError = BridgeReadError;
/** The guard of {@link ListBridgePaymentsError}. */
export const ListBridgePaymentsError = BridgeReadError;
/** The error union of {@link SecureClient.createDeposit}: see {@link BridgeSendError}. */
export type CreateDepositError = BridgeSendError;
/** The guard of {@link CreateDepositError}. */
export const CreateDepositError = BridgeSendError;
/** The error union of {@link SecureClient.withdraw}: see {@link BridgeSendError}. */
export type WithdrawError = BridgeSendError;
/** The guard of {@link WithdrawError}. */
export const WithdrawError = BridgeSendError;
/** The error union of {@link SecureClient.verifyBridgePayment}: see {@link BridgeSendError}. */
export type VerifyBridgePaymentError = BridgeSendError;
/** The guard of {@link VerifyBridgePaymentError}. */
export const VerifyBridgePaymentError = BridgeSendError;

const DIRECTIONS = ['deposit', 'withdraw'] as const;

/** A payment id: 1 to 128 letters, digits, underscores or hyphens. */
const paymentId = () => {
  const message =
    'must be a payment id: 1 to 128 letters, digits, underscores or hyphens';
  return z
    .string({ error: message })
    .regex(/^[A-Za-z0-9_-]{1,128}$/, { error: message });
};

/** A function that approves what the owner wallet is asked to sign. */
const verifyCallback = () =>
  z.custom<VerifyCallback>((value) => typeof value === 'function', {
    error: 'must be a function that returns true to approve',
  });

// ---------------------------------------------------------------------------
// listBridgeAssets
// ---------------------------------------------------------------------------

/** What {@link SecureClient.listBridgeAssets} takes. */
export type ListBridgeAssetsRequest = {
  /** `deposit` for what a deposit can be paid in, `withdraw` for what a withdrawal can deliver. */
  direction: BridgeDirection;
};

const AssetsSchema = z.strictObject({ direction: fields.oneOf(DIRECTIONS) });

/**
 * Lists the tokens a deposit can be paid in, or a withdrawal can deliver.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function listBridgeAssets(
  ctx: ActionContext,
  request: ListBridgeAssetsRequest,
  options?: RequestOptions,
): Paginated<BridgeAsset> {
  const input = parseInput('listBridgeAssets', request, AssetsSchema);
  const call = parseRequestOptions(options);
  const secure = secureOf(ctx, 'listBridgeAssets');
  secure.assertOpen();
  return toPaginated(
    'bridgeAssets',
    (cursor) => {
      noCursor(cursor);
      return singlePage(
        () => secure.bridge.assets(input.direction, call),
        (assets) => assets,
      );
    },
    toBridgeAsset,
  );
}

// ---------------------------------------------------------------------------
// quoteDeposit and quoteWithdrawal
// ---------------------------------------------------------------------------

/** What {@link SecureClient.quoteDeposit} takes. */
export type QuoteDepositRequest = {
  /** What to pay in: the `assetId` of a deposit asset, such as `base:0x8335…2913`. */
  assetId: string;
  /** How much of it, in whole units: a decimal string above 0, or a number. */
  amount: string | number;
};

/** What {@link SecureClient.quoteWithdrawal} takes. */
export type QuoteWithdrawalRequest = {
  /** What the recipient gets: the `assetId` of a withdrawal asset. */
  assetId: string;
  /** How much USDC leaves the trading wallet, in whole units: a decimal string above 0, or a number. */
  amount: string | number;
  /**
   * Who receives the asset, as its network writes addresses. A valid address that is wrong
   * cannot be undone: check it before you withdraw.
   */
  recipient: string;
};

const QuoteDepositSchema = z.strictObject({
  assetId: fields.text(),
  amount: fields.amount(),
});
const QuoteWithdrawalSchema = z.strictObject({
  assetId: fields.text(),
  amount: fields.amount(),
  recipient: fields.text(),
});

/**
 * Asks for the ways to deposit an amount of a token into XO.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function quoteDeposit(
  ctx: ActionContext,
  request: QuoteDepositRequest,
  options?: RequestOptions,
): Promise<DepositQuote[]> {
  const input = parseInput('quoteDeposit', request, QuoteDepositSchema);
  const call = parseRequestOptions(options);
  const secure = secureOf(ctx, 'quoteDeposit');
  secure.assertOpen();
  const { quotes } = await secure.bridge.quoteDeposit(
    { asset: input.assetId, amount: input.amount },
    call,
  );
  return quotes.map(toDepositQuote);
}

/**
 * Asks for the ways to withdraw an amount of USDC out of XO, as a token, to a recipient.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function quoteWithdrawal(
  ctx: ActionContext,
  request: QuoteWithdrawalRequest,
  options?: RequestOptions,
): Promise<WithdrawalQuote[]> {
  const input = parseInput('quoteWithdrawal', request, QuoteWithdrawalSchema);
  const call = parseRequestOptions(options);
  const secure = secureOf(ctx, 'quoteWithdrawal');
  secure.assertOpen();
  const { quotes } = await secure.bridge.quoteWithdraw(
    {
      asset: input.assetId,
      amount: input.amount,
      recipient: input.recipient,
    },
    call,
  );
  return quotes.map(toWithdrawalQuote);
}

// ---------------------------------------------------------------------------
// createDeposit, withdraw and verifyBridgePayment
// ---------------------------------------------------------------------------

/** What {@link SecureClient.createDeposit} takes. */
export type CreateDepositRequest = {
  /** One of the quotes `quoteDeposit` gave. */
  quote: DepositQuote;
  /**
   * Approves each thing the owner wallet is asked to sign, when the bridge asks for it: answer
   * `true` to approve. Without it, a deposit that asks fails with `verification_required`.
   */
  verify?: VerifyCallback;
};

const DepositQuoteSchema = z
  .looseObject(
    { paymentId: paymentId() },
    { error: 'must be a quote that quoteDeposit gave' },
  )
  .refine((quote) => quote.recipient === undefined, {
    error:
      'is a withdrawal quote, which has a recipient: withdraw it with withdraw',
  });

const CreateDepositSchema = z.strictObject({
  quote: DepositQuoteSchema,
  verify: verifyCallback().optional(),
});

/**
 * Confirms a deposit quote, once: the payment it gives says where to send the funds.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function createDeposit(
  ctx: ActionContext,
  request: CreateDepositRequest,
): Promise<BridgePayment> {
  const input = parseSendInput('createDeposit', request, CreateDepositSchema);
  const secure = openForSend(ctx, 'createDeposit');
  const quote = {
    paymentId: input.quote.paymentId,
    direction: 'deposit',
  } as RawBridgeQuote;
  return toBridgePayment(
    await secure.bridge.deposit(
      quote,
      input.verify === undefined ? {} : { verify: input.verify },
    ),
  );
}

/** What {@link SecureClient.withdraw} takes. */
export type WithdrawRequest = {
  /** One of the quotes `quoteWithdrawal` gave. Its amount is the most that is sent. */
  quote: WithdrawalQuote;
  /**
   * Approves each thing the owner wallet is asked to sign, when the bridge asks for it, as for
   * `createDeposit`.
   */
  verify?: VerifyCallback;
};

const WithdrawalQuoteSchema = z.looseObject(
  {
    paymentId: paymentId(),
    input: z.looseObject(
      { amount: fields.text() },
      { error: 'must be the input of a quote that quoteWithdrawal gave' },
    ),
    recipient: fields.text(
      'the recipient of a quote that quoteWithdrawal gave',
    ),
  },
  { error: 'must be a quote that quoteWithdrawal gave' },
);

const WithdrawSchema = z.strictObject({
  quote: WithdrawalQuoteSchema,
  verify: verifyCallback().optional(),
});

/**
 * Withdraws from XO: confirms a withdrawal quote, claims its funding once and sends the quoted
 * USDC once.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function withdraw(
  ctx: ActionContext,
  request: WithdrawRequest,
): Promise<BridgeWithdrawal> {
  const input = parseSendInput('withdraw', request, WithdrawSchema);
  const secure = openForSend(ctx, 'withdraw');
  // What the confirmed payment is checked against before anything is claimed or sent: the
  // quote's id, its amount (the most that is sent) and its recipient.
  const quote = {
    paymentId: input.quote.paymentId,
    direction: 'withdraw',
    input: { amount: input.quote.input.amount },
    recipient: input.quote.recipient,
  } as RawBridgeQuote;
  const { payment, tx } = await secure.bridge.withdraw(
    quote,
    input.verify === undefined ? {} : { verify: input.verify },
  );
  return {
    payment: toBridgePayment(payment),
    transaction: minedTransactionHandle(tx),
  };
}

/** What {@link SecureClient.verifyBridgePayment} takes. */
export type VerifyBridgePaymentRequest = {
  /** The payment's id: the `paymentId` of its quote, or of an error. */
  paymentId: string;
  /** Approves each thing the owner wallet is asked to sign: answer `true` to approve. */
  verify: VerifyCallback;
};

const VerifySchema = z.strictObject({
  paymentId: paymentId(),
  verify: verifyCallback(),
});

/**
 * Finishes a payment that waits for the owner wallet's signatures.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function verifyBridgePayment(
  ctx: ActionContext,
  request: VerifyBridgePaymentRequest,
): Promise<BridgePayment> {
  const input = parseSendInput('verifyBridgePayment', request, VerifySchema);
  const secure = openForSend(ctx, 'verifyBridgePayment');
  return toBridgePayment(
    await secure.bridge.verify(input.paymentId, { verify: input.verify }),
  );
}

// ---------------------------------------------------------------------------
// fetchBridgePayment, waitForBridgePayment and listBridgePayments
// ---------------------------------------------------------------------------

/** What {@link SecureClient.fetchBridgePayment} and {@link SecureClient.waitForBridgePayment} take. */
export type BridgePaymentRequest = {
  /** The payment's id: the `paymentId` of its quote, or of an error. */
  paymentId: string;
};

const PaymentSchema = z.strictObject({ paymentId: paymentId() });

/**
 * Reads one payment.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function fetchBridgePayment(
  ctx: ActionContext,
  request: BridgePaymentRequest,
  options?: RequestOptions,
): Promise<BridgePayment> {
  const input = parseInput('fetchBridgePayment', request, PaymentSchema);
  const call = parseRequestOptions(options);
  const secure = secureOf(ctx, 'fetchBridgePayment');
  secure.assertOpen();
  return toBridgePayment(await secure.bridge.get(input.paymentId, call));
}

/**
 * The options of {@link SecureClient.waitForBridgePayment}: a signal that ends the wait, and how long to
 * wait in all. A wait is not retried: it reads the payment again until it is final.
 */
export type WaitForBridgePaymentOptions = {
  /** Ends the wait: it rejects with a `RequestAbortedError` whose `cause` is the signal's reason. */
  signal?: AbortSignal;
  /**
   * How long to wait in all, in whole milliseconds, from 1 to 86 400 000 (24 hours). Defaults
   * to 3 600 000 (one hour).
   */
  timeout?: number;
};

/** The longest wait: 24 hours. */
const MAX_WAIT_MS = 86_400_000;

function readWaitOptions(options: unknown): WaitForBridgePaymentOptions {
  const refused = (message: string) =>
    withLanded(
      new UserInputError(message, { code: 'invalid_request_options' }),
      false,
    );
  if (options === undefined) {
    return {};
  }
  if (
    typeof options !== 'object' ||
    options === null ||
    Array.isArray(options)
  ) {
    throw refused('options must be an object with signal and timeout');
  }
  const record = options as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => key !== 'signal' && key !== 'timeout',
  );
  if (unknown !== undefined) {
    throw refused(
      `options has an unknown key "${unknown.slice(0, 40)}" (allowed: signal, timeout)`,
    );
  }
  const { signal, timeout } = record;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw refused('options.signal must be an AbortSignal');
  }
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > MAX_WAIT_MS)
  ) {
    throw refused(
      `options.timeout must be a whole number of milliseconds from 1 to ${MAX_WAIT_MS} (24 hours)`,
    );
  }
  return {
    ...(signal === undefined ? {} : { signal }),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

/**
 * Waits until a payment is final, reading it every 10 seconds.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function waitForBridgePayment(
  ctx: ActionContext,
  request: BridgePaymentRequest,
  options?: WaitForBridgePaymentOptions,
): Promise<BridgePayment> {
  const input = parseSendInput('waitForBridgePayment', request, PaymentSchema);
  const { signal, timeout } = readWaitOptions(options);
  const secure = openForSend(ctx, 'waitForBridgePayment');
  const aborted = (by: AbortSignal) =>
    withPaymentId(withLanded(abortedBy(by), false), input.paymentId);
  if (signal?.aborted) {
    throw aborted(signal);
  }
  try {
    return toBridgePayment(
      await secure.bridge.wait(input.paymentId, {
        ...(signal === undefined ? {} : { signal }),
        ...(timeout === undefined ? {} : { timeoutMs: timeout }),
      }),
    );
  } catch (error) {
    // The wait ends with the signal's reason, as it is: here it is the read's own error.
    if (signal?.aborted) {
      throw aborted(signal);
    }
    throw error;
  }
}

/** What {@link SecureClient.listBridgePayments} takes. Every key is optional. */
export type ListBridgePaymentsRequest = {
  /** Only deposits or only withdrawals. Both when left out. */
  direction?: BridgeDirection;
  /** Only the payments in this status, such as `COMPLETE`. A quote nobody confirmed is never listed. */
  status?: BridgePaymentStatus;
};

const PaymentsSchema = z.strictObject({
  direction: fields.oneOf(DIRECTIONS).optional(),
  status: fields.text().optional(),
});

/**
 * Lists the account's deposits and withdrawals, newest first.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export function listBridgePayments(
  ctx: ActionContext,
  request?: ListBridgePaymentsRequest,
  options?: RequestOptions,
): Paginated<BridgePayment> {
  const input = parseInput('listBridgePayments', request, PaymentsSchema);
  const call = parseRequestOptions(options);
  const secure = secureOf(ctx, 'listBridgePayments');
  secure.assertOpen();
  const filters = {
    ...(input.direction === undefined ? {} : { direction: input.direction }),
    ...(input.status === undefined ? {} : { status: input.status }),
  };
  // Checked now, so a bad status throws at once.
  secure.bridge.history(filters, call);
  return toPaginated(
    'bridgePayments',
    (cursor) => secure.bridge.history(filters, call, cursor),
    toBridgePayment,
  );
}
