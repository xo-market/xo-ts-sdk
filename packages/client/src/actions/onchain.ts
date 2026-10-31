import type { Address } from 'viem';
import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import { isSameAddress } from '../core/address';
import {
  AuthRequiredError,
  makeErrorGuard,
  RateLimitError,
  RequestRejectedError,
  SigningError,
  TimeoutError,
  TransactionFailedError,
  TransportError,
  UnexpectedResponseError,
  UserInputError,
  XoError,
} from '../core/errors';
import type { ConditionId } from '../core/types';
import {
  minedTransactionHandle,
  type RedemptionResult,
  type TransactionHandle,
} from '../models/account';
import { fields, openForSend, parseSendInput } from './internal';

// The on-chain sends of a signed-in client: the one-time approvals for trading, merging and
// redeeming outcome shares, and ERC-20 transfers. Each sends one transaction (a redeem of every
// market one per market) through the client's rail, XO's sponsor by default, and returns the
// handle of the mined transaction.
//
// A send goes out once. It is never repeated and never signed again, whatever happens to it. An
// error says with `mayHaveLanded` whether the transaction may be on chain: `false` when nothing
// was sent or it was refused for sure; `true` with the `transactionHash` (or, when the sponsor's
// answer was lost before it gave one, the executor `nonce`) to look it up by. No call that sends
// takes request options: aborting a send cannot undo it.

/**
 * The error union of the on-chain sends: the request (`UserInputError`, such as
 * `insufficient_balance` or `not_resolved`), the client's closing (`client_closed`), the
 * signer (`SigningError`), the reads before the send (a `chain_read_failed` `XoError`, and the
 * order book's reads), a refusal of the sponsor (`RequestRejectedError`, `RateLimitError`), and
 * a {@link TransactionFailedError} for the send itself, whose `mayHaveLanded` says whether the
 * transaction may be on chain.
 */
export type OnchainSendError =
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
/** The guard of {@link OnchainSendError}. */
export const OnchainSendError = makeErrorGuard(
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

/** The error union of {@link SecureClient.setupTradingApprovals}: see {@link OnchainSendError}. */
export type SetupTradingApprovalsError = OnchainSendError;
/** The guard of {@link SetupTradingApprovalsError}. */
export const SetupTradingApprovalsError = OnchainSendError;
/** The error union of {@link SecureClient.mergePositions}: see {@link OnchainSendError}. */
export type MergePositionsError = OnchainSendError;
/** The guard of {@link MergePositionsError}. */
export const MergePositionsError = OnchainSendError;
/** The error union of {@link SecureClient.redeemPositions}: see {@link OnchainSendError}. */
export type RedeemPositionsError = OnchainSendError;
/** The guard of {@link RedeemPositionsError}. */
export const RedeemPositionsError = OnchainSendError;
/**
 * The error union of {@link SecureClient.redeemAllPositions}: the errors before any market is redeemed (the
 * markets could not be read, a closed client). A market that fails is a result, not a throw.
 */
export type RedeemAllPositionsError = OnchainSendError;
/** The guard of {@link RedeemAllPositionsError}. */
export const RedeemAllPositionsError = OnchainSendError;
/** The error union of {@link SecureClient.transferErc20}: see {@link OnchainSendError}. */
export type TransferErc20Error = OnchainSendError;
/** The guard of {@link TransferErc20Error}. */
export const TransferErc20Error = OnchainSendError;

// ---------------------------------------------------------------------------
// setupTradingApprovals
// ---------------------------------------------------------------------------

/**
 * Sets the account up for trading, in one transaction, or does nothing when it is set up.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function setupTradingApprovals(
  ctx: ActionContext,
): Promise<TransactionHandle | null> {
  const secure = openForSend(ctx, 'setupTradingApprovals');
  const { receipt } = await secure.account.setupTransaction();
  return receipt === undefined ? null : minedTransactionHandle(receipt);
}

// ---------------------------------------------------------------------------
// mergePositions and redeemPositions
// ---------------------------------------------------------------------------

/** What {@link SecureClient.mergePositions} takes. */
export type MergePositionsRequest = {
  /** The market's condition id, `0x` and 64 hex digits. */
  conditionId: string;
  /**
   * How many full sets to merge, in whole shares (`'5'` merges 5 YES and 5 NO for 5 USDC), with
   * at most 6 decimals. Leave it out to merge all that is free of both outcomes.
   */
  amount?: string | number;
};

const MergeSchema = z.strictObject({
  conditionId: fields.conditionId(),
  amount: fields.amount().optional(),
});

/**
 * Merges YES and NO shares of one market back into USDC.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function mergePositions(
  ctx: ActionContext,
  request: MergePositionsRequest,
): Promise<TransactionHandle> {
  const input = parseSendInput('mergePositions', request, MergeSchema);
  const secure = openForSend(ctx, 'mergePositions');
  return minedTransactionHandle(
    await secure.account.merge(input.conditionId, input.amount),
  );
}

/** What {@link SecureClient.redeemPositions} takes. */
export type RedeemPositionsRequest = {
  /** The resolved market's condition id, `0x` and 64 hex digits. */
  conditionId: string;
};

const RedeemSchema = z.strictObject({ conditionId: fields.conditionId() });

/**
 * Redeems the account's shares of one resolved market.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function redeemPositions(
  ctx: ActionContext,
  request: RedeemPositionsRequest,
): Promise<TransactionHandle> {
  const input = parseSendInput('redeemPositions', request, RedeemSchema);
  const secure = openForSend(ctx, 'redeemPositions');
  return minedTransactionHandle(await secure.account.redeem(input.conditionId));
}

/**
 * Redeems every market the account can redeem, one transaction per market.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function redeemAllPositions(
  ctx: ActionContext,
): Promise<RedemptionResult[]> {
  const secure = openForSend(ctx, 'redeemAllPositions');
  const entries = await secure.account.redeemAll();
  return entries.map(({ conditionId, result, error }): RedemptionResult => {
    if (result !== undefined) {
      return {
        ok: true,
        conditionId: conditionId as ConditionId,
        transaction: minedTransactionHandle(result),
      };
    }
    // Every entry has a result or an error.
    return {
      ok: false,
      conditionId: conditionId as ConditionId,
      error: error as XoError,
    };
  });
}

// ---------------------------------------------------------------------------
// transferErc20
// ---------------------------------------------------------------------------

/** What {@link SecureClient.transferErc20} takes. */
export type TransferErc20Request = {
  /** The token's contract address. Leave it out for XO's USDC, the money of the markets. */
  token?: string;
  /** Who receives the tokens: an address. It may be neither the zero address nor the token. */
  to: string;
  /**
   * How much to send, in whole units of the token (`'5'` is 5 USDC), above 0 and with at most
   * as many decimals as the token has.
   */
  amount: string | number;
};

const TransferSchema = z.strictObject({
  token: fields.address().optional(),
  to: fields.address(),
  amount: fields.amount(),
});

/**
 * Sends an ERC-20 token, XO's USDC by default, from the trading wallet.
 *
 * The public documentation is on the `SecureClient` member of the same name.
 */
export async function transferErc20(
  ctx: ActionContext,
  request: TransferErc20Request,
): Promise<TransactionHandle> {
  const input = parseSendInput('transferErc20', request, TransferSchema);
  const secure = openForSend(ctx, 'transferErc20');
  const to = input.to as Address;
  const token = (input.token ?? ctx.env.contracts.usdc) as Address;
  // XO's USDC goes the way of every USDC transfer of the client, whose decimals are known.
  const result = isSameAddress(token, ctx.env.contracts.usdc)
    ? await secure.account.transferUsdc(to, input.amount)
    : await secure.account.transferErc20(token, to, input.amount);
  return minedTransactionHandle(result);
}
