import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  zeroHash,
} from 'viem';
import { normalizeAddress } from '../core/address';
import type { EnvironmentConfig } from '../core/env';
import {
  isRejected,
  RequestAbortedError,
  RequestRejectedError,
  UserInputError,
  XoError,
} from '../core/errors';
import { isConditionId, normalizeTokenId, parseTokenId } from '../core/ids';
import type { CallOptions } from '../core/requestOptions';
import type { ConditionId, DecimalString, TokenId } from '../core/types';
import type {
  Market as BackendMarket,
  DataClient,
  RewardsMarketConfig,
} from '../data/client';
import type { ContractReader, OrderbookClient } from '../orderbook/client';
import type { OrderbookMarket } from '../orderbook/schemas';
import { errorName } from '../wallet/internal';

// Cross-client market resolution: one call that turns "a market" (a backend id, a slug, a
// condition id or a contract address) into everything a trader needs to quote it, and a
// verdict on whether it can really be traded.
//
// The backend and the orderbook each know half of a market. The backend has the id, the slug,
// the expiry and the rewards; the orderbook has the outcome tokens, the tick size and whether
// it takes orders. Neither tells the whole truth about tradability, so the verdict adds three
// reads of the chain (see `resolveMarket`).

/** The result of one check of the {@link Tradable} verdict. */
export type CheckResult = 'pass' | 'fail' | 'unchecked';

/**
 * Why a market is not (or not verifiably) tradable. A stable code per failed or skipped check:
 *
 * - `orderbook_inactive`: the orderbook market is not active.
 * - `expired`: the market's expiry time has passed (the upstream status stays active).
 * - `expiry_unknown`: the backend gave no usable expiry time (none, or one without a `Z` or an
 *   offset), so expiry could not be checked.
 * - `chain_unchecked`: no chain reader was passed, so the three on-chain checks did not run.
 * - `not_prepared`: the condition is not prepared on ConditionalTokens with two outcomes.
 * - `already_resolved`: the condition has a payout denominator, so it is resolved.
 * - `not_registered_on_exchange`: the exchange does not know the YES token as this condition's
 *   (orders on it match and then fail to settle).
 */
export type TradableReason =
  | 'orderbook_inactive'
  | 'expired'
  | 'expiry_unknown'
  | 'chain_unchecked'
  | 'not_prepared'
  | 'already_resolved'
  | 'not_registered_on_exchange';

/** Each check of the verdict. `'unchecked'` means it could not run: it is never a pass. */
export interface TradableChecks {
  /** The orderbook market is active (`GET /markets/{condition_id}`, `active`). */
  orderbookActive: CheckResult;
  /** The backend's `expiresAt` has not passed. */
  notExpired: CheckResult;
  /** `ConditionalTokens.getOutcomeSlotCount(conditionId) == 2`. Needs a chain reader. */
  prepared: CheckResult;
  /** `ConditionalTokens.payoutDenominator(conditionId) == 0`. Needs a chain reader. */
  unresolved: CheckResult;
  /** `CTFExchange.getConditionId(yesTokenId) == conditionId`. Needs a chain reader. */
  registeredOnExchange: CheckResult;
}

/**
 * Whether the market can be traded. `ok` is true only when **every** check passed: a check
 * that failed or could not run (`'unchecked'`) makes it false, and `reasons` says which. Without
 * a chain reader the three on-chain checks cannot run, so `ok` is false: pass a `chain`.
 */
export interface Tradable {
  ok: boolean;
  /** One stable code per failed or unchecked check, in a fixed order; empty when `ok`. */
  reasons: TradableReason[];
  checks: TradableChecks;
}

/** A market joined across the backend and the orderbook. */
export interface ResolvedMarket {
  /** The backend's database id. */
  marketId: number;
  slug: string;
  /** The CTF condition id, in lower case. */
  conditionId: ConditionId;
  /** The orderbook token of the YES outcome (a decimal string). */
  yesTokenId: TokenId;
  /** The orderbook token of the NO outcome (a decimal string). */
  noTokenId: TokenId;
  /** The market's minimum tick size, such as `"0.001"`. */
  tickSize: DecimalString;
  /**
   * The orderbook's own status: whether it takes orders. This is **not** a tradability verdict
   * (expired and unregistered markets are reported active upstream); use `tradable`.
   */
  active: boolean;
  /**
   * The liquidity-rewards programmes of the market. Left out when the market has none (the
   * backend answers 404 for a market that is not enrolled).
   */
  rewards?: RewardsMarketConfig;
  tradable: Tradable;
}

/** What {@link resolveMarket} needs. The facade wires these; a test can pass its own. */
export interface ResolveDeps {
  data: DataClient;
  orderbook: OrderbookClient;
  /**
   * Reads the chain (read-only `eth_call`). Without it the three on-chain checks are
   * `'unchecked'` and `tradable.ok` is false.
   */
  chain?: ContractReader;
  /** Where the ConditionalTokens and CTFExchange contracts are. */
  env: EnvironmentConfig;
  /**
   * The clock for the expiry check, in milliseconds. Pass the server clock (the session's
   * `Clock`, `nowSec() * 1000`) so a wrong local clock cannot hide an expiry. Defaults to the
   * local clock, `Date.now()`.
   */
  nowMs?: () => number;
}

const NUMERIC = /^[0-9]+$/;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
/** The zero hash, as a plain string to compare with. */
const ZERO_HASH: string = zeroHash;
/** One ABI word: what each of the three contract reads returns. */
const WORD = /^0x[0-9a-fA-F]{64}$/;

type Target =
  | { kind: 'id'; value: number | string }
  | { kind: 'slug'; value: string }
  | { kind: 'contract'; value: string };

/**
 * Reads the caller's input: a number or numeric string is a backend id; `0x` and 64 hex
 * digits is a condition id; `0x` and 40 hex digits is a contract address (both go to the
 * backend's contract lookup, in lower case); anything else is a slug.
 */
function detect(input: unknown): Target {
  if (typeof input === 'number') {
    return { kind: 'id', value: input };
  }
  if (typeof input !== 'string') {
    throw new UserInputError(
      'input must be a market id, slug, condition id or contract address',
    );
  }
  const text = input.trim();
  if (NUMERIC.test(text)) {
    return { kind: 'id', value: text };
  }
  if (isConditionId(text, { upperCaseX: true }) || ADDRESS.test(text)) {
    return { kind: 'contract', value: text.toLowerCase() };
  }
  return { kind: 'slug', value: text };
}

function fetchBackendMarket(
  data: DataClient,
  target: Target,
  call: CallOptions | undefined,
): Promise<BackendMarket> {
  switch (target.kind) {
    case 'id':
      return data.markets.get(target.value, call);
    case 'slug':
      return data.markets.bySlug(target.value, call);
    case 'contract':
      return data.markets.byContract(target.value, call);
  }
}

/**
 * The market's CTF condition id, lower case. A CLOB market has one (`conditionId`, or its
 * `contractMarketId` when that is the condition id); a legacy LMSR or pulse market is keyed
 * by a contract address and has none.
 *
 * @internal
 */
export function conditionIdOf(market: BackendMarket): ConditionId | undefined {
  for (const candidate of [market.conditionId, market.contractMarketId]) {
    if (isConditionId(candidate, { upperCaseX: true })) {
      return candidate.toLowerCase() as ConditionId;
    }
  }
  return undefined;
}

const shortSlug = (market: BackendMarket): string =>
  JSON.stringify(
    market.slug.length > 80 ? `${market.slug.slice(0, 80)}…` : market.slug,
  );

/**
 * The market has no orderbook entry the SDK can trade: nothing was asked of the gateway.
 *
 * @internal
 */
export function notOnOrderbook(
  market: BackendMarket,
  why: string,
): UserInputError {
  return new UserInputError(
    `Market ${market.id} (${shortSlug(market)}) does not trade on the orderbook: ${why}`,
    { code: 'not_tradable_on_orderbook' },
  );
}

/**
 * The gateway answered 404 for the market: it does not know it.
 *
 * @internal
 */
export function unknownToGateway(
  market: BackendMarket,
  notFound: RequestRejectedError,
): RequestRejectedError {
  return new RequestRejectedError(
    `Market ${market.id} (${shortSlug(market)}) does not trade on the orderbook: the gateway does not know it`,
    {
      code: 'not_tradable_on_orderbook',
      service: 'orderbook',
      status: notFound.status,
      cause: notFound,
    },
  );
}

const outcomeLabel = (text: string): string =>
  JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);

/**
 * The YES and NO tokens, taken from the orderbook's own outcome labels (in any order or
 * case). A market that does not have exactly one YES and one NO outcome is refused.
 */
function binaryTokens(
  market: BackendMarket,
  book: OrderbookMarket,
): { yes: TokenId; no: TokenId } {
  const yes = book.tokens.filter(
    (t) => t.outcome.trim().toLowerCase() === 'yes',
  );
  const no = book.tokens.filter((t) => t.outcome.trim().toLowerCase() === 'no');
  const [yesToken] = yes;
  const [noToken] = no;
  if (
    book.tokens.length !== 2 ||
    yes.length !== 1 ||
    no.length !== 1 ||
    yesToken === undefined ||
    noToken === undefined
  ) {
    const shown = book.tokens.slice(0, 6).map((t) => outcomeLabel(t.outcome));
    const more =
      book.tokens.length > 6 ? `, … (${book.tokens.length} in all)` : '';
    throw new UserInputError(
      `Market ${market.id} (${shortSlug(market)}) is not a binary YES/NO market: its orderbook outcomes are [${shown.join(', ')}${more}]`,
      { code: 'not_binary', service: 'orderbook' },
    );
  }
  return {
    yes: normalizeTokenId(yesToken.token_id, 'yes token_id'),
    no: normalizeTokenId(noToken.token_id, 'no token_id'),
  };
}

// ---------------------------------------------------------------------------
// The chain reads
// ---------------------------------------------------------------------------

// Minimal fragments: the Gnosis ConditionalTokens reads and the exchange's token registry.
const CONDITIONAL_TOKENS_ABI = [
  {
    type: 'function',
    name: 'getOutcomeSlotCount',
    stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'payoutDenominator',
    stateMutability: 'view',
    inputs: [{ name: 'conditionId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

const EXCHANGE_ABI = [
  {
    type: 'function',
    name: 'getConditionId',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'uint256' }],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

function chainReadFailed(message: string): XoError {
  // No `cause`, on purpose: an RPC error can carry the node URL, and the URL a key.
  return new XoError(message, { code: 'chain_read_failed', service: 'chain' });
}

/** One read-only call that must answer one ABI word. */
async function callWord(
  chain: ContractReader,
  to: Address,
  data: Hex,
  what: string,
): Promise<Hex> {
  let result: unknown;
  try {
    result = await chain.readContract({ to, data });
  } catch (error) {
    throw chainReadFailed(`Reading ${what} failed (${errorName(error)})`);
  }
  if (typeof result !== 'string' || !WORD.test(result)) {
    throw chainReadFailed(
      `Reading ${what} returned something that is not one ABI word`,
    );
  }
  return result as Hex;
}

/** The two contracts the chain reads go to, validated. */
interface Contracts {
  conditionalTokens: Address;
  ctfExchange: Address;
}

interface ChainFacts {
  slotCount: bigint;
  payoutDenominator: bigint;
  /** What the exchange has registered for the YES token (lower case; the zero hash if nothing). */
  registeredCondition: string;
}

/** The three reads, in parallel. A read that fails or answers garbage throws `chain_read_failed`. */
async function readChain(
  chain: ContractReader,
  contracts: Contracts,
  conditionId: ConditionId,
  yesTokenId: TokenId,
): Promise<ChainFacts> {
  const tokens = contracts.conditionalTokens;
  const [slotWord, payoutWord, registeredWord] = await Promise.all([
    callWord(
      chain,
      tokens,
      encodeFunctionData({
        abi: CONDITIONAL_TOKENS_ABI,
        functionName: 'getOutcomeSlotCount',
        args: [conditionId],
      }),
      'ConditionalTokens.getOutcomeSlotCount',
    ),
    callWord(
      chain,
      tokens,
      encodeFunctionData({
        abi: CONDITIONAL_TOKENS_ABI,
        functionName: 'payoutDenominator',
        args: [conditionId],
      }),
      'ConditionalTokens.payoutDenominator',
    ),
    callWord(
      chain,
      contracts.ctfExchange,
      encodeFunctionData({
        abi: EXCHANGE_ABI,
        functionName: 'getConditionId',
        args: [parseTokenId(yesTokenId)],
      }),
      'CTFExchange.getConditionId',
    ),
  ]);
  // Each word was checked to be exactly 32 bytes of hex, so decoding a uint256 or a bytes32
  // from it cannot fail.
  return {
    slotCount: decodeFunctionResult({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'getOutcomeSlotCount',
      data: slotWord,
    }),
    payoutDenominator: decodeFunctionResult({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'payoutDenominator',
      data: payoutWord,
    }),
    registeredCondition: decodeFunctionResult({
      abi: EXCHANGE_ABI,
      functionName: 'getConditionId',
      data: registeredWord,
    }).toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * An ISO 8601 date-time with a `Z` or an offset, the form the backend sends. A time with
 * neither would be read as local time by `Date.parse`, and a date alone is ambiguous too, so
 * neither is trusted to decide an expiry.
 */
const ISO_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function expiryCheck(
  expiresAt: string | null | undefined,
  nowMs: number,
): CheckResult {
  if (typeof expiresAt !== 'string' || !ISO_WITH_OFFSET.test(expiresAt)) {
    return 'unchecked';
  }
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) {
    return 'unchecked';
  }
  return nowMs >= at ? 'fail' : 'pass';
}

function verdict(
  input: {
    active: boolean;
    expiresAt: string | null | undefined;
    nowMs: number;
    conditionId: ConditionId;
  },
  chain: ChainFacts | undefined,
): Tradable {
  const onChain = (pass: boolean): CheckResult =>
    chain === undefined ? 'unchecked' : pass ? 'pass' : 'fail';
  const checks: TradableChecks = {
    orderbookActive: input.active ? 'pass' : 'fail',
    notExpired: expiryCheck(input.expiresAt, input.nowMs),
    prepared: onChain(chain?.slotCount === 2n),
    unresolved: onChain(chain?.payoutDenominator === 0n),
    // The exchange answers the zero hash for a token it does not know: that is never a match.
    registeredOnExchange: onChain(
      chain?.registeredCondition === input.conditionId &&
        input.conditionId !== ZERO_HASH,
    ),
  };

  const reasons: TradableReason[] = [];
  if (checks.orderbookActive === 'fail') {
    reasons.push('orderbook_inactive');
  }
  if (checks.notExpired === 'fail') {
    reasons.push('expired');
  } else if (checks.notExpired === 'unchecked') {
    reasons.push('expiry_unknown');
  }
  if (chain === undefined) {
    reasons.push('chain_unchecked');
  } else {
    if (checks.prepared === 'fail') {
      reasons.push('not_prepared');
    }
    if (checks.unresolved === 'fail') {
      reasons.push('already_resolved');
    }
    if (checks.registeredOnExchange === 'fail') {
      reasons.push('not_registered_on_exchange');
    }
  }

  return {
    ok: Object.values(checks).every((check) => check === 'pass'),
    reasons,
    checks,
  };
}

// ---------------------------------------------------------------------------
// resolveMarket
// ---------------------------------------------------------------------------

/** The deps, checked, with the contract addresses validated when a chain reader is set. */
interface CheckedDeps {
  data: DataClient;
  orderbook: OrderbookClient;
  chain?: ContractReader;
  contracts?: Contracts;
  nowMs?: () => number;
}

function checkDeps(deps: unknown): CheckedDeps {
  const isObject = (value: unknown): boolean =>
    typeof value === 'object' && value !== null;
  if (!isObject(deps)) {
    throw new UserInputError('deps must be an object');
  }
  const { data, orderbook, env, chain, nowMs } = deps as Partial<ResolveDeps>;
  if (!isObject(data) || !isObject(orderbook) || !isObject(env)) {
    throw new UserInputError(
      'deps needs `data` (a DataClient), `orderbook` (an OrderbookClient) and `env`',
    );
  }
  if (nowMs !== undefined && typeof nowMs !== 'function') {
    throw new UserInputError('deps.nowMs must be a function');
  }
  const checked = {
    data: data as DataClient,
    orderbook: orderbook as OrderbookClient,
    ...(nowMs === undefined ? {} : { nowMs }),
  };
  if (chain === undefined) {
    return checked;
  }
  if (typeof chain?.readContract !== 'function') {
    throw new UserInputError(
      'deps.chain must be a ContractReader with a readContract function',
    );
  }
  // Only the chain reads use the contracts: without a reader `env` is not looked at again.
  const contracts: unknown = (env as Partial<EnvironmentConfig>).contracts;
  if (!isObject(contracts)) {
    throw new UserInputError(
      'deps.env.contracts must be an object when a chain reader is set',
    );
  }
  const { conditionalTokens, ctfExchange } = contracts as Partial<
    Record<keyof Contracts, string>
  >;
  return {
    ...checked,
    chain,
    contracts: {
      conditionalTokens: normalizeAddress(
        conditionalTokens as string,
        'env.contracts.conditionalTokens',
      ),
      ctfExchange: normalizeAddress(
        ctfExchange as string,
        'env.contracts.ctfExchange',
      ),
    },
  };
}

/**
 * Adds a hint to the backend's 404 for a slug that looks like a mistyped condition id or
 * address (`0x` and anything but 64 or 40 hex digits): such an input is a slug, as the input
 * rules say, and the 404 alone would not tell.
 */
function slugHint(error: unknown, target: Target): unknown {
  if (
    target.kind !== 'slug' ||
    !/^0x/i.test(target.value) ||
    !isRejected(error, 404)
  ) {
    return error;
  }
  return new RequestRejectedError(
    `${error.message} (the input was treated as a slug: a condition id is 0x and 64 hex characters, a contract address 0x and 40)`,
    {
      code: error.code,
      service: error.service,
      status: error.status,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      cause: error,
    },
  );
}

/** What the backend, the orderbook and the chain say about one market, joined. */
interface Parts {
  market: BackendMarket;
  conditionId: ConditionId;
  book: OrderbookMarket;
  /** Left out when the market has no programme, and when the rewards were not asked for. */
  rewards: RewardsMarketConfig | undefined;
  yes: TokenId;
  no: TokenId;
  tradable: Tradable;
}

/**
 * The body of {@link resolveMarket}. With `withRewards` false the rewards read is skipped
 * altogether, so a rewards outage cannot fail a call that only wants the verdict.
 * `beforeChain` runs after the HTTP reads and before the chain reads, which take no call
 * options: a caller that must stop there throws from it.
 */
async function resolveParts(
  input: string | number,
  deps: ResolveDeps,
  call: CallOptions | undefined,
  withRewards: boolean,
  beforeChain?: () => void,
): Promise<Parts> {
  const { data, orderbook, chain, contracts, nowMs } = checkDeps(deps);
  const target = detect(input);
  const now = (nowMs ?? (() => Date.now()))();
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new UserInputError(
      'nowMs must return a finite number of milliseconds',
    );
  }

  let market: BackendMarket;
  try {
    market = await fetchBackendMarket(data, target, call);
  } catch (error) {
    throw slugHint(error, target);
  }
  const conditionId = conditionIdOf(market);
  if (conditionId === undefined) {
    throw notOnOrderbook(
      market,
      `it has no condition id (type ${market.type}, a legacy market)`,
    );
  }

  // The orderbook market and the rewards config do not depend on each other. Rewards are
  // read last: an orderbook problem is the more important answer.
  const [bookResult, rewardsResult] = await Promise.allSettled([
    orderbook.getMarket(conditionId, call),
    withRewards
      ? data.rewards.marketConfig(conditionId, call)
      : Promise.resolve(undefined),
  ]);
  if (bookResult.status === 'rejected') {
    const error: unknown = bookResult.reason;
    if (isRejected(error, 404)) {
      throw unknownToGateway(market, error);
    }
    throw error;
  }
  const book = bookResult.value;
  const { yes, no } = binaryTokens(market, book);

  let rewards: RewardsMarketConfig | undefined;
  if (rewardsResult.status === 'fulfilled') {
    rewards = rewardsResult.value;
  } else if (!isRejected(rewardsResult.reason, 404)) {
    // Only "not enrolled" means "no rewards": an outage must not read as one.
    throw rewardsResult.reason;
  }

  beforeChain?.();
  const facts =
    chain === undefined || contracts === undefined
      ? undefined
      : await readChain(chain, contracts, conditionId, yes);

  return {
    market,
    conditionId,
    book,
    rewards,
    yes,
    no,
    tradable: verdict(
      {
        active: book.active,
        expiresAt: market.expiresAt,
        nowMs: now,
        conditionId,
      },
      facts,
    ),
  };
}

/**
 * Resolves a market across the backend and the orderbook, and says whether it can be traded.
 *
 * @param input A backend market id (a number or a numeric string), a slug, a condition id
 *   (`0x` and 64 hex digits, any case) or a contract address (`0x` and 40 hex digits).
 *   Spaces, tabs and newlines around the input are trimmed; inside a slug they are kept. Any
 *   other `0x…` text (63 or 65 hex digits, say) is a slug, and if the backend does not know
 *   it the 404 `RequestRejectedError` says it was treated as one. A
 *   contract address is the key of a legacy LMSR or pulse market (which resolve to
 *   `not_tradable_on_orderbook`); the `marketContractAddress` of a CLOB market is the shared
 *   market manager and finds nothing, so name a CLOB market by id, slug or condition id.
 *
 * **The tradable verdict.** `active` is only the orderbook's flag, and the gateway can report a
 * market active that cannot be traded: one that is not prepared on ConditionalTokens, or not
 * registered on the exchange. Orders on an unregistered market are accepted and matched, and
 * then settlement fails silently; expired markets stay active. So `tradable.ok` needs all of:
 *
 * | check | source | reason when it fails |
 * | --- | --- | --- |
 * | `orderbookActive` | orderbook `active` | `orderbook_inactive` |
 * | `notExpired` | backend `expiresAt` against the clock | `expired` (`expiry_unknown` if there is none) |
 * | `prepared` | `ConditionalTokens.getOutcomeSlotCount(conditionId) == 2` | `not_prepared` |
 * | `unresolved` | `ConditionalTokens.payoutDenominator(conditionId) == 0` | `already_resolved` |
 * | `registeredOnExchange` | `CTFExchange.getConditionId(yesTokenId) == conditionId` | `not_registered_on_exchange` |
 *
 * **Pass a chain reader.** The last three checks are `eth_call`s and run only when
 * `deps.chain` is set. Without it they are `'unchecked'`, and an unchecked check is not a
 * pass: `tradable.ok` is false (with the reason `chain_unchecked`). Read the verdict, never
 * just `active`.
 *
 * **The clock.** `notExpired` compares the backend's `expiresAt` (the orderbook's market has
 * no end time) with `deps.nowMs()`; the default is the local clock, so a wrong local clock can
 * hide an expiry or invent one. Pass the server clock when you have it. A market with no
 * usable `expiresAt` is `'unchecked'`: that includes a time without a `Z` or an offset
 * (`2026-12-01T00:00:00`), which would be read as local time, and a date alone.
 *
 * **Only YES is checked on the exchange.** The exchange registers both tokens of a market in
 * one call, so `getConditionId(yesTokenId)` stands for the pair. The verdict is a snapshot of
 * the latest block and the orderbook state at the time of the call; it is not a guarantee.
 *
 * **Binary markets only.** The tokens are the orderbook's own `Yes` and `No` outcomes. The
 * gateway's market object names those two outcomes for every market, so the `not_binary`
 * refusal (any other set of outcomes) is a guard, not a case to expect.
 *
 * `resolveMarket` is not called by the order builders or `placeOrder`: it costs three reads of
 * the chain. Use it to choose a market, then trade on the ids it returns.
 *
 * It sends no credentials and signs nothing: the backend, rewards and orderbook reads are
 * public.
 *
 * @throws {UserInputError} For input that is none of the above (before any request), a
 *   non-binary market (code `not_binary`: the orderbook's outcomes must be exactly YES and NO),
 *   or a legacy LMSR or pulse market (code `not_tradable_on_orderbook`).
 * @throws {RequestRejectedError} Status 404, the backend's own error, when it has no such
 *   market; status 404 with code `not_tradable_on_orderbook` when it has a CLOB market that the
 *   gateway does not know.
 * @throws {XoError} Code `chain_read_failed` (service `chain`) when a contract read fails or
 *   answers something unreadable: the verdict is never guessed.
 *
 * Internal: no entry of the package exports it. `fetchMarketTradability` reads the same
 * verdict through {@link checkTradable}.
 */
export async function resolveMarket(
  input: string | number,
  deps: ResolveDeps,
  call?: CallOptions,
): Promise<ResolvedMarket> {
  const { market, conditionId, book, rewards, yes, no, tradable } =
    await resolveParts(input, deps, call, true);
  return {
    marketId: market.id,
    slug: market.slug,
    conditionId,
    yesTokenId: yes,
    noTokenId: no,
    tickSize: book.minimum_tick_size,
    active: book.active,
    ...(rewards === undefined ? {} : { rewards }),
    tradable,
  };
}

/**
 * The tradable verdict of {@link resolveMarket} and nothing else: it reads the market, its
 * orderbook entry and the chain, but not the rewards. `conditionId` must be a condition id
 * (`0x` and 64 hex digits); anything else would be read as a slug.
 *
 * The two HTTP reads take `call`. The chain reads go through `ContractReader.readContract`,
 * which takes no call options, so `call.timeoutMs` and `call.retries` do not cover them. The
 * caller's signal is checked before the chain reads and again after them: an abort that
 * arrives while they run still ends in a `RequestAbortedError` whose `cause` is the signal's
 * reason, and no verdict is returned.
 *
 * @throws {RequestAbortedError} When `call.signal` is aborted by the time the HTTP reads are
 *   done or the chain reads are.
 * @internal
 */
export async function checkTradable(
  conditionId: string,
  deps: ResolveDeps,
  call?: CallOptions,
): Promise<Tradable> {
  const stopIfAborted = (): void => {
    const signal = call?.signal;
    if (signal?.aborted === true) {
      throw new RequestAbortedError('Checking tradability was aborted', {
        cause: signal.reason,
      });
    }
  };
  const parts = await resolveParts(
    conditionId,
    deps,
    call,
    false,
    stopIfAborted,
  );
  stopIfAborted();
  return parts.tradable;
}
