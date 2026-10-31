import { encodeFunctionData, maxUint256, zeroHash } from 'viem';
import { fromMicro } from '../core/decimal';
import type { EnvironmentConfig } from '../core/env';
import {
  TransactionFailedError,
  UserInputError,
  XoError,
} from '../core/errors';
import { isConditionId, normalizeConditionId } from '../core/ids';
import type { ConditionId } from '../core/types';
import type { PortfolioApi } from '../data/portfolio';
import type { OrderbookClient } from '../orderbook/client';
import type { MarketCapacity } from '../orderbook/schemas';
import type { Call } from '../signing/kernel';
import { errorName, isObject } from '../wallet/internal';
import { CONDITIONAL_TOKENS_ABI } from './abis';
import type { TxResult } from './chain';
import { MICRO_UNITS, unexpectedOrderbookAnswer } from './internal';

// Merging and redeeming outcome tokens, for `AccountClient`. The orderbook
// trades binary conditions on the Gnosis ConditionalTokens contract: YES is index set 1
// (0b01), NO is index set 2 (0b10), both top-level positions (parent collection bytes32(0))
// with USDC as the collateral. A merge burns N YES and N NO for N USDC; a redeem burns the
// trader's YES and NO of a resolved condition for what they pay out. Both act on the
// tokens of the sender, the trading address the rail sends from.
//
// This module works out what to send; `AccountClient` reads, checks and sends.

/** The partition of a binary condition, and its index sets: YES = 1, NO = 2. */
const BINARY_INDEX_SETS: readonly bigint[] = [1n, 2n];

/**
 * The most data-client redeemable positions {@link redeemCandidates} uses: ten pages of 100,
 * largest claim first. When there are more, `redeemAll()` warns once; it still has every
 * market the orderbook lists as claimable.
 */
export const MAX_REDEEMABLE_SCAN = 1000;

/** Positions per page of `portfolio.redeemable()`: the most the route takes. */
const REDEEMABLE_PAGE_SIZE = 100;

/**
 * The query of `portfolio.redeemable()`: the trader's own positions (not a creator's), the
 * largest claim first, so a cut list leaves out the smallest claims, and rows that pay
 * nothing (such as an unresolved market) come last. No `marketScope`: the SDK's default,
 * `withPulse`, lists every type, while the backend's `onlyClob` is types 2 and 3 only and
 * would leave out conviction markets (4). The types are filtered here instead.
 */
const REDEEMABLE_QUERY = {
  role: 'user',
  sortBy: 'claimableAmount',
  sortOrder: 'DESC',
  take: REDEEMABLE_PAGE_SIZE,
} as const;

/**
 * The backend market types that settle on ConditionalTokens: 2 CLOB, 3 CLOB pulse, 4 CLOB
 * conviction. Types 0 (standard LMSR) and 1 (pulse) settle on their own market contracts,
 * so redeeming them here would do nothing.
 */
export const CLOB_MARKET_TYPES: ReadonlySet<number> = new Set([2, 3, 4]);

/** The part of the data client `redeemAll()` reads: `portfolio.redeemable()`. */
export interface AccountData {
  portfolio: Pick<PortfolioApi, 'redeemable'>;
}

/**
 * One market of {@link AccountClient.redeemAll}: either the mined transaction (`result`,
 * whose `status` may be `'reverted'`) or why there is none (`error`).
 */
export interface RedeemAllEntry {
  conditionId: ConditionId;
  /** The rail's result, as it is. A reverted transaction is a result, not an error. */
  result?: TxResult;
  /**
   * Why this market has no result. `mayHaveLanded: false` means nothing was sent for it
   * (a check, a read, a refused send, or `skipped_after_ambiguous`). Any other error may
   * have landed: reconcile it before redeeming that market again.
   */
  error?: XoError;
}

type Contracts = Pick<
  EnvironmentConfig['contracts'],
  'usdc' | 'conditionalTokens'
>;

/** `ConditionalTokens.mergePositions(USDC, bytes32(0), conditionId, [1, 2], amount)`. */
export function mergeCall(
  contracts: Contracts,
  conditionId: ConditionId,
  amount: bigint,
): Call {
  return {
    to: contracts.conditionalTokens,
    data: encodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'mergePositions',
      args: [contracts.usdc, zeroHash, conditionId, BINARY_INDEX_SETS, amount],
    }),
    value: 0n,
  };
}

/** `ConditionalTokens.redeemPositions(USDC, bytes32(0), conditionId, [1, 2])`. */
export function redeemCall(
  contracts: Contracts,
  conditionId: ConditionId,
): Call {
  return {
    to: contracts.conditionalTokens,
    data: encodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'redeemPositions',
      args: [contracts.usdc, zeroHash, conditionId, BINARY_INDEX_SETS],
    }),
    value: 0n,
  };
}

// ---------------------------------------------------------------------------
// merge: the amount
// ---------------------------------------------------------------------------

const CAPACITY = '/data/market-capacity';

/** What the orderbook says is free of one outcome, in micro-shares, checked. */
function freeOf(entry: Record<string, unknown>, index: number): bigint {
  const field = `positions[${index}].free_position`;
  const free = entry.free_position;
  if (typeof free !== 'string' || !MICRO_UNITS.test(free)) {
    throw unexpectedOrderbookAnswer(
      CAPACITY,
      field,
      'must be a non-negative integer of micro-units',
    );
  }
  const micro = BigInt(free);
  if (micro > maxUint256) {
    throw unexpectedOrderbookAnswer(CAPACITY, field, 'must fit a uint256');
  }
  return micro;
}

/**
 * The micro-shares `merge()` merges in `conditionId`, from the orderbook's capacity answer.
 * YES and NO are found by their `outcome` label (in any case), never by their place in the
 * list. The free amount is `min(free YES, free NO)`: shares reserved by resting SELL orders
 * or pending settlement are not free. Without `requested`, all of it is merged.
 * @throws UnexpectedResponseError (service `orderbook`) when an outcome is not YES or NO, one is listed twice, or a `free_position` is not micro-units.
 * @throws UserInputError `nothing_to_merge` when YES or NO is missing (the orderbook lists no position for a market it does not know) or the free amount is 0; `amount_exceeds_free`, naming the free amount, when `requested` is above it.
 */
export function mergeAmount(
  capacity: MarketCapacity,
  conditionId: ConditionId,
  requested: bigint | undefined,
): bigint {
  const positions: unknown = isObject(capacity)
    ? capacity.positions
    : undefined;
  if (!Array.isArray(positions)) {
    throw unexpectedOrderbookAnswer(CAPACITY, 'positions', 'must be an array');
  }
  const sides = new Map<'YES' | 'NO', bigint>();
  positions.forEach((entry: unknown, index) => {
    const outcome = isObject(entry) ? entry.outcome : undefined;
    const label =
      typeof outcome === 'string' ? outcome.trim().toUpperCase() : undefined;
    if (!isObject(entry) || (label !== 'YES' && label !== 'NO')) {
      throw unexpectedOrderbookAnswer(
        CAPACITY,
        `positions[${index}].outcome`,
        'must be YES or NO: a merge of [1, 2] is for a binary market',
      );
    }
    if (sides.has(label)) {
      throw unexpectedOrderbookAnswer(
        CAPACITY,
        'positions',
        `must list ${label} once, not twice`,
      );
    }
    sides.set(label, freeOf(entry, index));
  });

  const yes = sides.get('YES');
  const no = sides.get('NO');
  if (yes === undefined || no === undefined) {
    const missing =
      yes === undefined && no === undefined
        ? 'no YES or NO position (none at all for a market the engine does not know)'
        : `no ${yes === undefined ? 'YES' : 'NO'} position`;
    throw new UserInputError(
      `Nothing to merge in ${conditionId}: the orderbook lists ${missing} there. Nothing was sent`,
      { code: 'nothing_to_merge' },
    );
  }
  const free = yes < no ? yes : no;
  const sidesText = `free YES ${fromMicro(yes)}, free NO ${fromMicro(no)}; shares reserved by resting SELL orders or pending settlement are not free`;
  if (free === 0n) {
    throw new UserInputError(
      `Nothing to merge in ${conditionId}: a merge needs YES and NO, and 0 of one is free (${sidesText}). Nothing was sent`,
      { code: 'nothing_to_merge' },
    );
  }
  if (requested === undefined) {
    return free;
  }
  if (requested > free) {
    throw new UserInputError(
      `Cannot merge ${fromMicro(requested)} in ${conditionId}: only ${fromMicro(free)} is free to merge (${sidesText}). Nothing was sent`,
      { code: 'amount_exceeds_free' },
    );
  }
  return requested;
}

// ---------------------------------------------------------------------------
// redeemAll: the markets, and one redeem after another
// ---------------------------------------------------------------------------

const CLAIMABLE = '/claimable';

/** What {@link redeemCandidates} found. */
export interface RedeemCandidates {
  /** The markets, in the order they are redeemed. */
  conditionIds: ConditionId[];
  /**
   * Whether the data client listed more than {@link MAX_REDEEMABLE_SCAN} redeemable
   * positions, so that the ones past the cap were not read.
   */
  truncated: boolean;
}

/**
 * The markets `redeemAll()` redeems, without duplicates, in a fixed order: the orderbook's
 * claimable markets (`GET /claimable`) in the order it lists them, then, with `data`, the
 * markets of `portfolio.redeemable()` in the order they first appear.
 *
 * The data positions are the trader's own (`role: 'user'`, and a row of another role is
 * skipped), largest claim first, at most {@link MAX_REDEEMABLE_SCAN} of them, every page up
 * to there; one more is fetched to tell whether the list was cut (`truncated`). Only those
 * of types 2, 3 and 4 (CLOB, CLOB pulse, CLOB conviction) whose `contractMarketId` is a
 * condition id are kept: standard LMSR (0) and pulse (1) markets settle on their own
 * contracts, not on ConditionalTokens.
 * @throws the orderbook's or the data client's error, as it is, when a read fails.
 * @throws UnexpectedResponseError (service `orderbook`) when a claimable `market_id` is not a condition id.
 */
export async function redeemCandidates(
  orderbook: Pick<OrderbookClient, 'getClaimable'>,
  data: AccountData | undefined,
): Promise<RedeemCandidates> {
  // A Set keeps the order of first insertion.
  const found = new Set<ConditionId>();
  const answer = await orderbook.getClaimable();
  const claimable: unknown = isObject(answer) ? answer.claimable : undefined;
  if (!Array.isArray(claimable)) {
    throw unexpectedOrderbookAnswer(CLAIMABLE, 'claimable', 'must be an array');
  }
  claimable.forEach((entry: unknown, index) => {
    const id = isObject(entry) ? entry.market_id : undefined;
    if (!isConditionId(id)) {
      throw unexpectedOrderbookAnswer(
        CLAIMABLE,
        `claimable[${index}].market_id`,
        'must be a condition id: 0x and 64 hex characters',
      );
    }
    found.add(normalizeConditionId(id));
  });

  let truncated = false;
  if (data !== undefined) {
    // One past the cap: it is there only when the list goes on.
    const listed = await data.portfolio
      .redeemable({ ...REDEEMABLE_QUERY })
      .toArray(MAX_REDEEMABLE_SCAN + 1);
    truncated = listed.length > MAX_REDEEMABLE_SCAN;
    for (const position of listed.slice(0, MAX_REDEEMABLE_SCAN)) {
      const { role, type, contractMarketId } = position;
      if (
        role === 'user' &&
        CLOB_MARKET_TYPES.has(type) &&
        isConditionId(contractMarketId)
      ) {
        found.add(normalizeConditionId(contractMarketId));
      }
    }
  }
  return { conditionIds: [...found], truncated };
}

/** The warning of a `redeemAll()` whose data list was cut at {@link MAX_REDEEMABLE_SCAN}. */
export function truncationWarning(): string {
  return `redeemAllPositions(): XO lists more than ${MAX_REDEEMABLE_SCAN} redeemable positions, and only the first ${MAX_REDEEMABLE_SCAN} (largest claim first) were read. Call redeemAllPositions() again once these redemptions have landed to pick up more`;
}

/** What a redeem threw, as an `XoError`. Anything else is a failure that may have been sent. */
function asXoError(thrown: unknown, conditionId: ConditionId): XoError {
  if (thrown instanceof XoError) {
    return thrown;
  }
  // No cause: an unexpected error could be a raw RPC error, which can hold the node URL.
  return new TransactionFailedError(
    `The redeem of ${conditionId} failed unexpectedly (${errorName(thrown)}): it may have been sent`,
    { mayHaveLanded: true, code: 'send_failed' },
  );
}

/** The error of a market that was not tried, because the redeem of `prior` may have landed. */
function skippedAfter(prior: {
  conditionId: ConditionId;
  error: XoError;
}): TransactionFailedError {
  return new TransactionFailedError(
    `Not sent: the redeem of ${prior.conditionId} before it may have landed (${prior.error.code}), and a new transaction could take the same nonce. Reconcile that one, then call redeemAllPositions() again`,
    { mayHaveLanded: false, code: 'skipped_after_ambiguous' },
  );
}

/**
 * Runs `redeem` for each market, one after another, and reports each one.
 *
 * - A result (a mined transaction, reverted or not) is recorded, and the next market follows.
 * - An error with `mayHaveLanded: false` (nothing was sent) is recorded, and the next follows.
 * - Any other error (the send may have landed, or does not say) is recorded, and nothing
 *   more is sent: a new transaction could take the nonce of the unknown one. Every market
 *   after it gets a `TransactionFailedError` `skipped_after_ambiguous` (`mayHaveLanded: false`).
 */
export async function redeemEach(
  markets: readonly ConditionId[],
  redeem: (conditionId: ConditionId) => Promise<TxResult>,
): Promise<RedeemAllEntry[]> {
  const entries: RedeemAllEntry[] = [];
  let ambiguous: { conditionId: ConditionId; error: XoError } | undefined;
  for (const conditionId of markets) {
    if (ambiguous !== undefined) {
      entries.push({ conditionId, error: skippedAfter(ambiguous) });
      continue;
    }
    try {
      entries.push({ conditionId, result: await redeem(conditionId) });
    } catch (thrown) {
      const error = asXoError(thrown, conditionId);
      entries.push({ conditionId, error });
      if (error.mayHaveLanded !== false) {
        ambiguous = { conditionId, error };
      }
    }
  }
  return entries;
}
