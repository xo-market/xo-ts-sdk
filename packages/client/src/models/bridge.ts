import type { Address } from 'viem';
import type {
  BridgeAmount as RawBridgeAmount,
  BridgeAsset as RawBridgeAsset,
  BridgeFees as RawBridgeFees,
  BridgePayment as RawBridgePayment,
  BridgeQuote as RawBridgeQuote,
} from '../bridge/schemas';
import { isDecimalString } from '../core/decimal';
import type { DecimalString } from '../core/types';
import type { TransactionHandle } from './account';
import { addressOf, unexpectedField } from './convert';

// The public bridge models: moving money into XO (a deposit, paid in any token the bridge
// supports) and out of it (a withdrawal, sent as any such token). A deposit lands as USDC in
// the trading wallet whatever it was paid in. Amounts are whole-unit decimals of the asset
// they name. A bridge asset is named by an asset id, `network:address` (such as
// `base:0x8335...2913`); that is not an outcome token.

/** Which way money moves: a `deposit` into XO or a `withdraw` out of it. */
export type BridgeDirection = 'deposit' | 'withdraw';

/** A token a deposit can be paid in, or a withdrawal can be sent as. */
export type BridgeAsset = {
  /** The asset id, `network:address`. Pass it back as the asset of a quote. */
  assetId: string;
  /** The network's name, such as `base` or `ethereum`. */
  chain: string;
  /**
   * The network's EVM chain id as a decimal string (`"8453"` for Base), or `null` for a
   * network of another address family. It is text because some chain ids do not fit a
   * JavaScript number.
   */
  chainId: string | null;
  /** The address family of the network, such as `EVM` or `SOLANA`. */
  addressFamily: string;
  /** The token's symbol, such as `USDC`. */
  symbol: string;
  /** The token's name, such as `USD Coin`. */
  name: string;
  /** The token's decimals (6 for USDC). */
  decimals: number;
  /** The token's address on its network. */
  address: string;
  /** Whether the token is the network's own coin. */
  isNative: boolean;
  /** The token's logo. */
  image: string | null;
};

/**
 * Maps a token the bridge supports to the {@link BridgeAsset} model.
 *
 * @internal
 */
export function toBridgeAsset(raw: RawBridgeAsset): BridgeAsset {
  return {
    assetId: raw.asset,
    chain: raw.chain,
    chainId: raw.chainId,
    addressFamily: raw.addressFamily,
    symbol: raw.symbol,
    name: raw.name,
    decimals: raw.decimals,
    address: raw.address,
    isNative: raw.isNative,
    image: raw.imageUrl,
  };
}

/** An amount of one asset, in whole units of that asset. */
export type BridgeAmount = {
  /** The asset id, `network:address`. */
  assetId: string;
  /** The amount, such as `"25.5"`. */
  amount: DecimalString;
};

/** What a payment costs, in `currency`. A fee the bridge states in a form that is not a plain decimal is `null`. */
export type BridgeFees = {
  /** All the fees together. */
  total: DecimalString | null;
  /** The fee for converting between assets. */
  conversion: DecimalString | null;
  /** The network (gas) fee. */
  network: DecimalString | null;
  /** The business fee. */
  business: DecimalString | null;
  /** The currency the fees are in, such as `USD`. */
  currency: string;
};

function amountOf(raw: RawBridgeAmount): BridgeAmount {
  return { assetId: raw.asset, amount: raw.amount };
}

function feeOf(value: string): DecimalString | null {
  return isDecimalString(value) ? value : null;
}

function feesOf(raw: RawBridgeFees): BridgeFees {
  return {
    total: feeOf(raw.total),
    conversion: feeOf(raw.conversion),
    network: feeOf(raw.network),
    business: feeOf(raw.business),
    currency: raw.currency,
  };
}

/**
 * A quote to deposit money into XO. Confirming it (creating the deposit) turns it into a
 * payment; it can be confirmed until `acceptBy`.
 */
export type DepositQuote = {
  /** The id of the payment this quote becomes when it is confirmed. */
  paymentId: string;
  /** What you pay in. */
  input: BridgeAmount;
  /** What XO credits: USDC in the trading wallet. */
  output: BridgeAmount;
  /** What the deposit costs. */
  fees: BridgeFees;
  /** The expected time to deliver, in seconds. `null` when the bridge gives none. */
  latencySeconds: number | null;
  /** The quote can be confirmed until then, as an ISO 8601 time. */
  acceptBy: string;
};

/**
 * A quote to withdraw money out of XO. Confirming it (withdrawing) turns it into a payment;
 * it can be confirmed until `acceptBy`.
 */
export type WithdrawalQuote = {
  /** The id of the payment this quote becomes when it is confirmed. */
  paymentId: string;
  /** What leaves XO: USDC from the trading wallet. */
  input: BridgeAmount;
  /** What the recipient gets. */
  output: BridgeAmount;
  /** What the withdrawal costs. */
  fees: BridgeFees;
  /** The expected time to deliver, in seconds. `null` when the bridge gives none. */
  latencySeconds: number | null;
  /** The quote can be confirmed until then, as an ISO 8601 time. */
  acceptBy: string;
  /** The address that receives the money, as it was given. A valid address that is wrong cannot be undone. */
  recipient: string;
};

function quoteBody(raw: RawBridgeQuote) {
  return {
    paymentId: raw.paymentId,
    input: amountOf(raw.input),
    output: amountOf(raw.output),
    fees: feesOf(raw.fees),
    latencySeconds: raw.latencySeconds,
    acceptBy: raw.acceptBy,
  };
}

/**
 * Maps a quote option of a deposit to the {@link DepositQuote} model.
 *
 * @throws {UnexpectedResponseError} When the quote is not a deposit quote.
 * @internal
 */
export function toDepositQuote(raw: RawBridgeQuote): DepositQuote {
  if (raw.direction !== 'deposit') {
    throw unexpectedField('direction', 'deposit', 'backend');
  }
  return quoteBody(raw);
}

/**
 * Maps a quote option of a withdrawal to the {@link WithdrawalQuote} model.
 *
 * @throws {UnexpectedResponseError} When the quote is not a withdrawal quote, or has no
 *   recipient.
 * @internal
 */
export function toWithdrawalQuote(raw: RawBridgeQuote): WithdrawalQuote {
  if (raw.direction !== 'withdraw') {
    throw unexpectedField('direction', 'withdraw', 'backend');
  }
  if (raw.recipient === undefined) {
    throw unexpectedField('recipient', 'given', 'backend');
  }
  return { ...quoteBody(raw), recipient: raw.recipient };
}

/**
 * Where a payment is in its life. A status added later reads as its own string. The statuses
 * that end it are `COMPLETE`, `EXPIRED` and `TAINTED`; `HALTED` is not final.
 *
 * - `QUOTED`: a quote nobody confirmed.
 * - `CONFIRM_UNKNOWN`: confirming the quote timed out or failed with a server error, so the
 *   outcome is unknown. Read the payment again, and do not confirm again.
 * - `NEEDS_VERIFICATION`: the bridge asks the owner wallet to sign first.
 * - `AWAITING_FUNDS`: confirmed, waiting for the money (see {@link BridgePayment.deposit}).
 * - `PROCESSING`: the bridge has the money and is delivering.
 * - `COMPLETE`: delivered. Final.
 * - `HALTED`: stopped, but it may still finish or need recovery (see
 *   {@link BridgePayment.recoveryUrl}). Not final.
 * - `EXPIRED`: not funded in time. Final.
 * - `TAINTED`: the bridge will not complete the payment. Final.
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

/**
 * Where to send the money of a confirmed payment, and how much: send exactly `amount` of the
 * asset `assetId` on `chain` to `address`, once, before the payment's `fundBy`.
 */
export type BridgeDeposit = {
  /** The one-time address for this payment, on `chain`. Send to it once. */
  address: string;
  /** How much to send, in whole units of the asset (`"25.5"` is 25.5 tokens). Send exactly this much. */
  amount: DecimalString;
  /** The asset to send, as an asset id (`network:address`), not a symbol. */
  assetId: string;
  /** The network to send on, such as `base`. */
  chain: string;
};

/** One thing the bridge asks the owner wallet to sign before the payment goes on. */
export type BridgeVerificationItem = {
  /** What the signature is for: `EVM_OWNER` or `EVM_WITHDRAWAL`. A reason added later reads as its own string. */
  reason: 'EVM_OWNER' | 'EVM_WITHDRAWAL' | (string & {});
  /** How `payload` is signed: `EIP712` (typed data) or `EIP191` (a message). */
  signatureType: 'EIP712' | 'EIP191' | (string & {});
  /** What the owner wallet signs, as the bridge sent it. */
  payload: string;
};

/** A payment through the bridge: a quote, a deposit or a withdrawal. */
export type BridgePayment = {
  /** The payment's id. */
  paymentId: string;
  /** `deposit` into XO or `withdraw` out of it. */
  direction: BridgeDirection;
  /** Where the payment is in its life. */
  status: BridgePaymentStatus;
  /** The last status the bridge provider reported, for support. `null` before it reported one. */
  providerStatus: string | null;
  /** What goes in. */
  input: BridgeAmount;
  /** What comes out. */
  output: BridgeAmount;
  /** What the payment costs. */
  fees: BridgeFees;
  /** The wallet that owns the payment. `null` before the quote was confirmed. */
  ownerAddress: Address | null;
  /** Where the output is delivered: the trading wallet for a deposit, the recipient for a withdrawal. */
  destinationAddress: string;
  /** A withdrawal's recipient. `null` for a deposit. */
  recipient: string | null;
  /** The quote could be confirmed until then, as an ISO 8601 time. */
  acceptBy: string;
  /** The money must be sent by then, as an ISO 8601 time. `null` before the quote was confirmed. */
  fundBy: string | null;
  /** Where and how much to send. `null` until the bridge has said. */
  deposit: BridgeDeposit | null;
  /** What to sign. Set only while the status is `NEEDS_VERIFICATION`. */
  verification: BridgeVerificationItem[] | null;
  /** When the funding of a withdrawal was claimed, as an ISO 8601 time. `null` if it was not. */
  fundingClaimedAt: string | null;
  /** The transaction that sent the money, once the bridge has seen it. It is a transaction of the paying network. */
  fundingTransactionHash: string | null;
  /** The transaction that delivered the output. `null` until it is delivered. */
  deliveryTransactionHash: string | null;
  /** The bridge provider's recovery page. Set only while the status is `HALTED`. */
  recoveryUrl: string | null;
  /** When the payment was created (the quote was asked for), as an ISO 8601 time. */
  createdAt: string;
  /** When the payment last changed, as an ISO 8601 time. */
  updatedAt: string;
  /** When the payment completed, as an ISO 8601 time. `null` while it has not. */
  completedAt: string | null;
};

/**
 * Maps a payment to the {@link BridgePayment} model.
 *
 * @internal
 */
export function toBridgePayment(raw: RawBridgePayment): BridgePayment {
  return {
    paymentId: raw.paymentId,
    direction: raw.direction,
    status: raw.status,
    providerStatus: raw.hallidayStatus,
    input: amountOf(raw.input),
    output: amountOf(raw.output),
    fees: feesOf(raw.fees),
    ownerAddress:
      raw.ownerAddress === null ? null : addressOf(raw.ownerAddress),
    destinationAddress: raw.destinationAddress,
    recipient: raw.recipient,
    acceptBy: raw.acceptBy,
    fundBy: raw.fundBy,
    deposit:
      raw.deposit === null
        ? null
        : {
            address: raw.deposit.address,
            amount: raw.deposit.amount,
            assetId: raw.deposit.token,
            chain: raw.deposit.chain,
          },
    verification:
      raw.verification === null
        ? null
        : raw.verification.items.map((item) => ({
            reason: item.reason,
            signatureType: item.signatureType,
            payload: item.payload,
          })),
    fundingClaimedAt: raw.fundingClaimedAt,
    fundingTransactionHash: raw.fundingTxHash,
    deliveryTransactionHash: raw.deliveryTxHash,
    recoveryUrl: raw.recoveryUrl,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    completedAt: raw.completedAt,
  };
}

/**
 * A withdrawal that was made: the payment as XO answered once its funding was claimed, and the
 * USDC transfer that funded it, mined. Follow the payment with `waitForBridgePayment`.
 *
 * A `transaction` whose `wait()` says `reverted` did not fund the payment, and the funding claim
 * is used: send the payment's `deposit.amount` to its `deposit.address` yourself (once, before
 * `fundBy`), then follow it.
 */
export type BridgeWithdrawal = {
  /** The payment, with its `fundingClaimedAt` set. */
  payment: BridgePayment;
  /** The USDC transfer from the trading wallet to the payment's deposit address. */
  transaction: TransactionHandle;
};
