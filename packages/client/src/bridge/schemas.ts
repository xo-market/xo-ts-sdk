// Response schemas of the bridge client (the backend's bridge routes).
//
// Each schema mirrors one answer of the backend, which sends its objects as they are, so
// the field names are the backend's own (camelCase). Timestamps are ISO-8601
// strings, as JSON carries them, and amounts are decimal strings.

import { z } from 'zod';
import type { TxResult } from '../account/chain';
import {
  decimalString,
  defineSchema,
  type EnumFactory,
  type ObjFactory,
} from '../core/schema';

/** Which way funds move: `'deposit'` into XO, `'withdraw'` out of it. */
export type BridgeDirection = 'deposit' | 'withdraw';

/** A token a deposit can be paid in or a withdrawal can be sent out as. */
export interface BridgeAsset {
  /**
   * The asset id, `network:address` (for example `base:0x8335…2913`). Send it back as the
   * `asset` of a quote.
   */
  asset: string;
  /** The bridge provider's network name, such as `'base'` or `'ethereum'`. */
  chain: string;
  /**
   * The network's EVM chain id as a decimal string (`'8453'` for Base), or `null` for a network
   * of another address family. It is a string because a chain id is a 256-bit number and some
   * networks' ids do not fit a JavaScript number (the bridge lists one with 77 digits). Compare
   * it with `String(chain.id)`.
   */
  chainId: string | null;
  /** The address family of the network, such as `'EVM'` or `'SOLANA'`. */
  addressFamily: string;
  /** The token symbol, such as `'USDC'`. */
  symbol: string;
  /** The token name, such as `'USD Coin'`. */
  name: string;
  /** The token's decimals (6 for USDC). */
  decimals: number;
  /** The token's address on its network. */
  address: string;
  /** Whether the token is the network's native coin. */
  isNative: boolean;
  /** A logo, when the bridge provider has one. */
  imageUrl: string | null;
}

/**
 * A chain id as a decimal string: a plain decimal of at most 78 digits (a uint256), or a safe
 * non-negative JSON integer turned into its string. The backend relays the bridge provider's
 * `chain_id`, which the provider's live API sends as a decimal string (`{"#": "8453"}`), since
 * some ids do not fit a JavaScript number.
 */
const chainIdField = z.union([
  z.string().regex(/^\d{1,78}$/, 'expected a decimal chain id'),
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(String),
]);

// One asset the bridge can move.
const bridgeAsset = (obj: ObjFactory) =>
  obj({
    asset: z.string(),
    chain: z.string(),
    chainId: chainIdField.nullable(),
    addressFamily: z.string(),
    symbol: z.string(),
    name: z.string(),
    decimals: z.number(),
    address: z.string(),
    isNative: z.boolean(),
    imageUrl: z.string().nullable(),
  });

// `GET /bridge/halliday/assets`.
export const BridgeAssetsSchema = defineSchema<{ data: BridgeAsset[] }>((obj) =>
  obj({ data: z.array(bridgeAsset(obj)) }),
);

/**
 * Where a payment is in its life. The statuses that end it are `'COMPLETE'`, `'EXPIRED'` and
 * `'TAINTED'`; `'HALTED'` is not final. Any other string is a status this SDK version does not
 * know yet.
 *
 * - `'QUOTED'`: a quote option nobody confirmed. It is not in `history()`.
 * - `'CONFIRM_UNKNOWN'`: the confirm (or the verification) call timed out or failed with a
 *   server error, so the outcome is unknown: read the payment again, and do not confirm again.
 * - `'NEEDS_VERIFICATION'`: the bridge asks the owner to sign first (`verification` is set).
 * - `'AWAITING_FUNDS'`: confirmed; waiting for the funds (`deposit` says where to send them).
 * - `'PROCESSING'`: the bridge provider has the funds and is delivering.
 * - `'COMPLETE'`: delivered. Final.
 * - `'HALTED'`: stopped, but it may still finish or need recovery (`recoveryUrl` is the bridge's
 *   recovery page). Not final.
 * - `'EXPIRED'`: not funded in time. Final.
 * - `'TAINTED'`: the bridge provider will not complete the payment. Final.
 */
export type BridgePaymentStatus =
  | 'QUOTED'
  | 'CONFIRM_UNKNOWN'
  | 'NEEDS_VERIFICATION'
  | 'AWAITING_FUNDS'
  | 'PROCESSING'
  | 'COMPLETE'
  | 'HALTED'
  | 'EXPIRED'
  | 'TAINTED'
  | (string & {});

const PAYMENT_STATUSES = [
  'QUOTED',
  'CONFIRM_UNKNOWN',
  'NEEDS_VERIFICATION',
  'AWAITING_FUNDS',
  'PROCESSING',
  'COMPLETE',
  'HALTED',
  'EXPIRED',
  'TAINTED',
] as const;

/** An amount of one asset. */
export interface BridgeAmount {
  /** The asset id, `network:address`, as in {@link BridgeAsset.asset}. */
  asset: string;
  /** A plain decimal string in whole units of the asset, such as `'25.5'`. */
  amount: string;
}

/**
 * What a payment costs, in `currency`. The amounts are decimal strings as the bridge sends them
 * (such as `'0.05'`): the SDK passes them on without checking their form, so parse them with care.
 */
export interface BridgeFees {
  /** All the fees together. */
  total: string;
  /** The fee for converting between assets. */
  conversion: string;
  /** The network (gas) fee. */
  network: string;
  /** The business fee. */
  business: string;
  /** The currency the fees are in, such as `'USD'`. */
  currency: string;
}

/**
 * One option of a quote request. It is a payment in the `'QUOTED'` status: confirm it to turn
 * it into a deposit or a withdrawal. It can be confirmed until `acceptBy`.
 */
export interface BridgeQuote {
  /** The payment this option becomes when it is confirmed. */
  paymentId: string;
  /** Copied from the request: `'deposit'` for `quoteDeposit`, `'withdraw'` for `quoteWithdraw`. */
  direction: BridgeDirection;
  /** What goes in: the source token of a deposit, XO USDC for a withdrawal. */
  input: BridgeAmount;
  /** What comes out: XO USDC for a deposit, the target token for a withdrawal. */
  output: BridgeAmount;
  /** What the option costs. */
  fees: BridgeFees;
  /** The bridge's estimate of how long delivery takes, in seconds, or `null` when it gives none. */
  latencySeconds: number | null;
  /** ISO time: the option can be confirmed until then. The same for every option of one answer. */
  acceptBy: string;
  /**
   * Copied from the request of `quoteWithdraw`: the address the withdrawal delivers to, as it was
   * given. A deposit quote has none. `withdraw` refuses (`bridge_funding_mismatch`) a confirmed
   * payment whose `recipient` is another address, before it claims or sends anything.
   */
  recipient?: string;
}

/** The answer to a quote request. */
export interface BridgeQuotes {
  /**
   * The options, the one that pays out the most first (sorted by `output.amount`; options that
   * pay the same keep the backend's order). `quotes[0]` is the usual choice.
   */
  quotes: BridgeQuote[];
  /** ISO time: every option can be confirmed until then. */
  acceptBy: string;
  /**
   * What the bridge accepts for the request, in units of the input token. A `null` bound is one
   * the bridge did not state.
   */
  limits: { min: string | null; max: string | null }[];
}

/**
 * Where to send the funds of a confirmed payment, and how much: send exactly `amount` of `token`
 * on `chain` to `address`, once, before the payment's `fundBy`.
 *
 * For a deposit, find the asset first:
 * `(await bridge.assets('deposit')).find((a) => a.asset === deposit.token)`. Its `address` is
 * the token contract to transfer, its `decimals` turn `amount` into the base units a transfer
 * takes (`parseUnits(deposit.amount, asset.decimals)` with viem), and when `isNative` is `true`
 * you send the network's own coin instead of a token. `parseUnits` rounds an amount with more
 * decimal places than the token has, and can round a dust amount to 0: refuse those instead of
 * sending another amount, and send nothing once `fundBy` has passed. The deposits guide has the
 * whole recipe. A withdrawal's deposit is sent by `withdraw()` itself.
 */
export interface BridgeDeposit {
  /** The bridge provider's one-time address for this payment, on `chain`. Send to it once. */
  address: string;
  /**
   * How much to send: a decimal string in whole units of `token` (`'25.5'` is 25.5 tokens), not
   * in base units. Send exactly this much.
   */
  amount: string;
  /**
   * The token to send, as an asset id `network:address`: the same id as
   * {@link BridgeAsset.asset} (such as `base:0x8335…2913`), not a symbol. For a withdrawal it is
   * XO USDC (`xo:` and the environment's USDC contract).
   */
  token: string;
  /** The bridge's network name to send on, as {@link BridgeAsset.chain} names it, such as `'base'` (`'xo'` for a withdrawal). */
  chain: string;
}

/** One thing the bridge provider asks the owner wallet to sign before it goes on. */
export interface BridgeVerificationItem {
  /** What the signature is for: `'EVM_OWNER'` or `'EVM_WITHDRAWAL'`. Any other string is a reason this SDK version does not know yet. */
  reason: 'EVM_OWNER' | 'EVM_WITHDRAWAL' | (string & {});
  /** How `payload` is signed: `'EIP712'` (typed data) or `'EIP191'` (a message). */
  signatureType: 'EIP712' | 'EIP191' | (string & {});
  /** What the owner wallet signs, as the bridge provider sent it. */
  payload: string;
}

/** XO's view of one payment: a quote option, a deposit or a withdrawal. */
export interface BridgePayment {
  /** The payment id. */
  paymentId: string;
  /** `'deposit'` into XO or `'withdraw'` out of it. */
  direction: BridgeDirection;
  /** Where the payment is in its life. */
  status: BridgePaymentStatus;
  /** The last status the bridge reported, for support, or `null` before it has reported one. */
  hallidayStatus: string | null;
  /** What goes in. */
  input: BridgeAmount;
  /** What comes out. */
  output: BridgeAmount;
  /** What the payment costs. */
  fees: BridgeFees;
  /** The wallet that owns the payment, or `null` before the quote was confirmed. */
  ownerAddress: string | null;
  /** Where the output is delivered: the trading wallet for a deposit, the recipient for a withdrawal. */
  destinationAddress: string;
  /** A withdrawal's recipient, or `null` for a deposit. */
  recipient: string | null;
  /** ISO time: the quote could be confirmed until then. */
  acceptBy: string;
  /** ISO time: the funds must be sent by then, or `null` before the quote was confirmed. */
  fundBy: string | null;
  /** Where and how much to send, once the bridge provider has said; `null` before that. */
  deposit: BridgeDeposit | null;
  /** What to sign, only while the status is `'NEEDS_VERIFICATION'`; `null` otherwise. */
  verification: { items: BridgeVerificationItem[] } | null;
  /** ISO time the funding of a withdrawal was claimed, or `null`. */
  fundingClaimedAt: string | null;
  /** The transaction that sent the funds, once the bridge provider has seen it, or `null`. */
  fundingTxHash: string | null;
  /** The transaction that delivered the output, or `null` until it is delivered. */
  deliveryTxHash: string | null;
  /** The bridge provider's recovery page, only while the status is `'HALTED'`; `null` otherwise. */
  recoveryUrl: string | null;
  /** ISO time the payment was created (the quote was asked for). */
  createdAt: string;
  /** ISO time the payment last changed. */
  updatedAt: string;
  /** ISO time the payment completed, or `null` while it has not. */
  completedAt: string | null;
}

/**
 * What `withdraw()` resolves with when the funding was claimed and the USDC transfer ran: the
 * payment the claim answered, and the transfer's result.
 */
export interface BridgeWithdrawal {
  /**
   * The payment as the funding claim answered it: `fundingClaimedAt` is set. It is still
   * `'AWAITING_FUNDS'` here, because the bridge has not seen the funds yet. Follow it with
   * `get(paymentId)` or `wait(paymentId)`. If the claim's answer lacks fields of a full payment,
   * this is the confirmed payment with the claim's `fundingClaimedAt`: the claim is used, so the
   * transfer is never given up for a field `withdraw` does not read.
   */
  payment: BridgePayment;
  /**
   * The USDC transfer to the bridge's deposit address, as the rail reports it. **A reverted
   * transfer is a result, not an error**: `tx.status` is `'reverted'`, nothing reached the bridge,
   * and the claim is used all the same, so `withdraw()` cannot send it again. Send the deposit's
   * amount yourself with `account.transferUsdc(getAddress(payment.deposit.address),
   * payment.deposit.amount)` (`getAddress` is viem's) before `payment.fundBy`.
   */
  tx: TxResult;
}

/** The options of `history()`. */
export interface BridgeHistoryOptions {
  /** Only deposits or only withdrawals. Both when left out. */
  direction?: BridgeDirection;
  /**
   * Only payments in this status. Every status but `'QUOTED'` can be asked for: a quote nobody
   * confirmed is not history.
   */
  status?: BridgePaymentStatus;
}

// An amount of a quote: an asset and a decimal string.
const bridgeAmount = (obj: ObjFactory) =>
  obj({ asset: z.string(), amount: decimalString });

// The fees of a quote.
const bridgeFees = (obj: ObjFactory) =>
  obj({
    total: z.string(),
    conversion: z.string(),
    network: z.string(),
    business: z.string(),
    currency: z.string(),
  });

// `POST /bridge/halliday/quotes`. The backend sends neither
// `direction`, a per-option `acceptBy` nor a withdrawal's `recipient`: the client copies them in.
// Every field is read (returned to the caller, or sorted by), so every field is required.
export const BridgeQuotesSchema = defineSchema<{
  data: {
    quotes: Omit<BridgeQuote, 'direction' | 'acceptBy' | 'recipient'>[];
    acceptBy: string;
    limits: BridgeQuotes['limits'];
  };
}>((obj) =>
  obj({
    data: obj({
      quotes: z.array(
        obj({
          paymentId: z.string(),
          input: bridgeAmount(obj),
          output: bridgeAmount(obj),
          fees: bridgeFees(obj),
          latencySeconds: z.number().nullable(),
        }),
      ),
      acceptBy: z.string(),
      limits: z.array(
        obj({ min: z.string().nullable(), max: z.string().nullable() }),
      ),
    }),
  }),
);

// One payment, as every payment route answers it.
const bridgePayment = (obj: ObjFactory, enumOf: EnumFactory) =>
  obj({
    paymentId: z.string(),
    // The public type is `BridgeDirection`, so an unknown direction fails the response in both
    // flavours: every branch on it (a withdrawal is funded, a deposit is not) needs it known.
    direction: z.enum(['deposit', 'withdraw']),
    status: enumOf(PAYMENT_STATUSES),
    hallidayStatus: z.string().nullable(),
    input: bridgeAmount(obj),
    output: bridgeAmount(obj),
    fees: bridgeFees(obj),
    ownerAddress: z.string().nullable(),
    destinationAddress: z.string(),
    recipient: z.string().nullable(),
    acceptBy: z.string(),
    fundBy: z.string().nullable(),
    deposit: obj({
      address: z.string(),
      amount: decimalString,
      token: z.string(),
      chain: z.string(),
    }).nullable(),
    verification: obj({
      items: z.array(
        obj({
          reason: enumOf(['EVM_OWNER', 'EVM_WITHDRAWAL']),
          signatureType: enumOf(['EIP712', 'EIP191']),
          payload: z.string(),
        }),
      ),
    }).nullable(),
    fundingClaimedAt: z.string().nullable(),
    fundingTxHash: z.string().nullable(),
    deliveryTxHash: z.string().nullable(),
    recoveryUrl: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullable(),
  });

// `GET /bridge/halliday/payments/:paymentId`: the payment, bare.
export const BridgePaymentSchema = defineSchema<BridgePayment>(bridgePayment);

// `GET /bridge/halliday/payments`: one page of payments.
export const BridgePaymentPageSchema = defineSchema<{
  data: BridgePayment[];
  nextCursor: string | null;
}>((obj, enumOf) =>
  obj({
    data: z.array(bridgePayment(obj, enumOf)),
    nextCursor: z.string().nullable(),
  }),
);

/**
 * What `withdraw` reads from the answer of a funding claim, and nothing else. Internal: not
 * exported from the package.
 */
export interface BridgeFundingClaim {
  /** The payment the claim answered for. */
  paymentId: string;
  /** ISO time the funding was claimed; `null` when the answer does not show a claim. */
  fundingClaimedAt: string | null;
  /** The deposit instructions the claim answered with, to compare with the ones that were checked. */
  deposit?: {
    address: string;
    amount: string;
    token: string;
    chain: string;
  } | null;
}

// The answer of `POST /bridge/halliday/payments/:paymentId/funding-claim`, a payment.
// A claim is one-time and the transfer comes after it, so the answer must not be able to fail
// the call for a field the SDK does not read: only the fields `withdraw` reads are required, and
// the object is loose in the strict flavour too (an unknown field is kept, never refused).
const fundingClaim: z.ZodType<BridgeFundingClaim> = z.looseObject({
  paymentId: z.string(),
  fundingClaimedAt: z.string().nullable(),
  deposit: z
    .looseObject({
      address: z.string(),
      amount: decimalString,
      token: z.string(),
      chain: z.string(),
    })
    .nullable()
    .optional(),
});

export const BridgeFundingClaimSchema = defineSchema<BridgeFundingClaim>(
  () => fundingClaim,
);
