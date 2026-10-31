import {
  type Address,
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  isHex,
  maxUint256,
  zeroAddress,
} from 'viem';
import { isSameAddress, normalizeAddress } from '../core/address';
import {
  fromMicro,
  fromUnits,
  toMicro,
  toUnits,
  type WholeUnits,
} from '../core/decimal';
import type { EnvironmentConfig } from '../core/env';
import {
  TransactionFailedError,
  UserInputError,
  XoError,
} from '../core/errors';
import { normalizeConditionId, normalizeTokenId } from '../core/ids';
import type { ConditionId, DecimalString, TokenId } from '../core/types';
import type { OrderbookClient } from '../orderbook/client';
import type { Positions } from '../orderbook/schemas';
import type { Call } from '../signing/kernel';
import type { TradingIdentity } from '../wallet/identity';
import { isObject } from '../wallet/internal';
import type { InternalSigner } from '../wallet/signer';
import { CONDITIONAL_TOKENS_ABI, ERC20_ABI } from './abis';
import type { ChainReader, TxResult } from './chain';
import {
  describeFailure,
  isEmptyCode,
  MICRO_UNITS,
  unexpectedOrderbookAnswer,
  withLanded,
} from './internal';
import { preflightRail, type TxRail } from './rails';
import {
  type AccountData,
  mergeAmount,
  mergeCall,
  type RedeemAllEntry,
  redeemCall,
  redeemCandidates,
  redeemEach,
  truncationWarning,
} from './settle';

// The account client: what the trader holds, and the on-chain steps around trading. Funds and approvals live at the trading address, `identity.address`: the owner for
// an EOA, the smart wallet for a smart wallet. Reads go through the ChainReader. A write is a
// batch of plain calls handed to the TxRail, which wraps them in `execute` for a smart wallet
// and deploys the smart wallet first when it has no code yet. Merge and redeem are
// worked out in `./settle`.

/**
 * The USDC allowance below which `setup()` approves again: 2^255. A max approval
 * (2^256 - 1) stays above it however much is spent, even on a token that decrements a max
 * allowance, so a set-up account is never approved twice; anything below it was not a max
 * approval.
 */
export const LOW_ALLOWANCE = 2n ** 255n;

/**
 * The most token ids one `ConditionalTokens.balanceOfBatch` asks for. A larger portfolio is
 * read in several calls, so no single `eth_call` grows past what a node accepts.
 */
export const BALANCE_BATCH_SIZE = 500;

/** One step of {@link AccountClient.setup}, in the order it is always reported and sent. */
export type SetupAction =
  | 'deploy'
  | 'approve_usdc'
  | 'approve_ctf'
  | 'approve_manager';

/** The options of {@link AccountClient.setup}. */
export interface SetupOptions {
  /**
   * Also approve USDC (max) to the ClobMarketManager when its allowance is low
   * (`approve_manager`). Defaults to `false`: the orderbook settles through the CTFExchange,
   * whose approvals `setup()` always sets.
   */
  includeMarketManager?: boolean;
}

/** What {@link AccountClient.setup} did. */
export interface SetupResult {
  /** The hash of the one setup transaction. Absent when there was nothing to do. */
  txHash?: Hex;
  /** What the transaction did, in order. Empty when the account was already set up: nothing was sent. */
  actions: SetupAction[];
}

/** The options of {@link AccountClient.getBalances}. */
export interface BalancesOptions {
  /** Outcome tokens to read on chain, besides those the orderbook reports in `/positions`. */
  tokenIds?: ReadonlyArray<TokenId | string>;
}

/** One position as the orderbook sees it, in whole shares. */
export interface OrderbookPositionBalance {
  tokenId: TokenId;
  /** The shares the orderbook credits to the trader. */
  balance: DecimalString;
  /** Of those, the shares reserved by resting SELL orders. */
  reserved: DecimalString;
}

/** What {@link AccountClient.getBalances} returns. Every amount is in whole units (USDC, shares). */
export interface Balances {
  /** The USDC on chain at the trading address. */
  usdc: DecimalString;
  /** The outcome-token balances on chain at the trading address, by token id (canonical decimal). */
  tokens: Record<string, DecimalString>;
  /**
   * The orderbook's view, from `GET /positions`. What is free to commit per market is
   * `orderbook.getMarketCapacity(conditionId)`.
   */
  orderbook: {
    /** The cash the orderbook credits to the trader. */
    cash: DecimalString;
    positions: OrderbookPositionBalance[];
  };
}

/** The part of the orderbook client the account client uses. */
export type AccountOrderbook = Pick<
  OrderbookClient,
  'getPositions' | 'getMarketCapacity' | 'getClaimable'
>;

/** The options of {@link AccountClient}. The secure client wires them from its one session (see the class docs). */
export interface AccountClientOptions {
  env: EnvironmentConfig;
  /**
   * Who trades. Called at the start of every operation and never cached here, so the session
   * stays the one place the identity is resolved.
   */
  identity: () => Promise<TradingIdentity>;
  /** The owner's signer. The account client does not use it (the rail signs). */
  signer?: InternalSigner;
  /**
   * Sends the transactions of `setup`, `transferUsdc`, `merge`, `redeem` and `redeemAll`.
   * Without it those throw a `UserInputError` `rail_not_configured`; the reads work.
   */
  rail?: TxRail;
  /** Reads balances, approvals, code and resolution (`readContract`, `getCode`). */
  chain: ChainReader;
  /**
   * The orderbook client: `/positions` for `getBalances`, the market capacity for `merge`,
   * and `/claimable` for `redeemAll`.
   */
  orderbook: AccountOrderbook;
  /**
   * The data client, optional. With it `redeemAll` also redeems the CLOB markets of
   * `portfolio.redeemable()`, besides the orderbook's claimable ones.
   */
  data?: AccountData;
  /**
   * Defaults to `console.warn`. Never receives a secret. Called once by a `redeemAll` whose
   * data list was cut at 1000 positions (`MAX_REDEEMABLE_SCAN`). A callback that throws is
   * ignored.
   */
  warn?: (message: string) => void;
}

// ---------------------------------------------------------------------------
// Chain reads
// ---------------------------------------------------------------------------

function chainReadFailed(what: string, detail: string): XoError {
  // No `cause`, on purpose: an RPC error can carry the node URL, and the URL a key.
  return new XoError(`Reading ${what} failed: ${detail}`, {
    code: 'chain_read_failed',
    service: 'chain',
  });
}

/** One read-only call. A failure, or an answer that is not hex, is `chain_read_failed`. */
async function call(
  chain: ChainReader,
  to: Address,
  data: Hex,
  what: string,
): Promise<Hex> {
  let result: unknown;
  try {
    result = await chain.readContract({ to, data });
  } catch (error) {
    throw chainReadFailed(what, describeFailure(error));
  }
  if (typeof result !== 'string' || !isHex(result)) {
    throw chainReadFailed(what, 'the answer is not hex');
  }
  return result;
}

/** Decodes an answer; one that does not decode is `chain_read_failed`. */
function decoded<T>(what: string, decode: () => T): T {
  try {
    return decode();
  } catch {
    throw chainReadFailed(what, 'the answer does not decode');
  }
}

async function readAllowance(
  chain: ChainReader,
  usdc: Address,
  holder: Address,
  spender: Address,
): Promise<bigint> {
  const what = 'USDC.allowance';
  const result = await call(
    chain,
    usdc,
    encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [holder, spender],
    }),
    what,
  );
  return decoded(what, () =>
    decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: 'allowance',
      data: result,
    }),
  );
}

/**
 * `USDC.balanceOf(holder)`, in micro-USDC. Internal: not exported from the package. The bridge
 * client reads the trading wallet's balance with it before it claims the funding of a withdrawal.
 */
export async function readUsdcBalance(
  chain: ChainReader,
  usdc: Address,
  holder: Address,
): Promise<bigint> {
  const what = 'USDC.balanceOf';
  const result = await call(
    chain,
    usdc,
    encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [holder],
    }),
    what,
  );
  return decoded(what, () =>
    decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      data: result,
    }),
  );
}

/** `token.balanceOf(holder)`, in the token's base units. */
async function readTokenBalance(
  chain: ChainReader,
  token: Address,
  holder: Address,
): Promise<bigint> {
  const what = `the balance of token ${token}`;
  const result = await call(
    chain,
    token,
    encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [holder],
    }),
    what,
  );
  return decoded(what, () =>
    decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      data: result,
    }),
  );
}

/** `token.decimals()`: how many decimals a whole unit of the token has. */
async function readDecimals(
  chain: ChainReader,
  token: Address,
): Promise<number> {
  const what = `the decimals of token ${token}`;
  const result = await call(
    chain,
    token,
    encodeFunctionData({ abi: ERC20_ABI, functionName: 'decimals' }),
    what,
  );
  return decoded(what, () =>
    decodeFunctionResult({
      abi: ERC20_ABI,
      functionName: 'decimals',
      data: result,
    }),
  );
}

async function readOperatorApproval(
  chain: ChainReader,
  conditionalTokens: Address,
  holder: Address,
  operator: Address,
): Promise<boolean> {
  const what = 'ConditionalTokens.isApprovedForAll';
  const result = await call(
    chain,
    conditionalTokens,
    encodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'isApprovedForAll',
      args: [holder, operator],
    }),
    what,
  );
  return decoded(what, () =>
    decodeFunctionResult({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'isApprovedForAll',
      data: result,
    }),
  );
}

/** One `balanceOfBatch` of `ids` held by `holder`; `chunk` names it in an error. */
async function readTokenBatch(
  chain: ChainReader,
  conditionalTokens: Address,
  holder: Address,
  ids: readonly TokenId[],
  chunk: string,
): Promise<readonly bigint[]> {
  const what = `ConditionalTokens.balanceOfBatch${chunk}`;
  const result = await call(
    chain,
    conditionalTokens,
    encodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'balanceOfBatch',
      args: [ids.map(() => holder), ids.map((id) => BigInt(id))],
    }),
    what,
  );
  const balances = decoded(what, () =>
    decodeFunctionResult({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'balanceOfBatch',
      data: result,
    }),
  );
  if (balances.length !== ids.length) {
    throw chainReadFailed(
      what,
      `${balances.length} balances answered for ${ids.length} tokens`,
    );
  }
  return balances;
}

/**
 * The balances of `ids` held by `holder`, in the order of `ids`: one `balanceOfBatch` per
 * {@link BALANCE_BATCH_SIZE} ids, in parallel, each checked to answer one balance per id.
 */
async function readTokenBalances(
  chain: ChainReader,
  conditionalTokens: Address,
  holder: Address,
  ids: readonly TokenId[],
): Promise<readonly bigint[]> {
  const chunks: TokenId[][] = [];
  for (let at = 0; at < ids.length; at += BALANCE_BATCH_SIZE) {
    chunks.push(ids.slice(at, at + BALANCE_BATCH_SIZE));
  }
  const answers = await Promise.all(
    chunks.map((chunk, i) =>
      readTokenBatch(
        chain,
        conditionalTokens,
        holder,
        chunk,
        chunks.length === 1
          ? ''
          : ` (ids ${i * BALANCE_BATCH_SIZE} to ${i * BALANCE_BATCH_SIZE + chunk.length - 1})`,
      ),
    ),
  );
  return answers.flat();
}

/** Whether `address` has code: the `eth_getCode` answer is not empty ({@link isEmptyCode}). */
async function hasCode(chain: ChainReader, address: Address): Promise<boolean> {
  const what = 'the account code (eth_getCode)';
  let code: unknown;
  try {
    code = await chain.getCode(address);
  } catch (error) {
    throw chainReadFailed(what, describeFailure(error));
  }
  if (typeof code !== 'string' || !isHex(code)) {
    throw chainReadFailed(what, 'the answer is not hex');
  }
  return !isEmptyCode(code);
}

/** `ConditionalTokens.payoutDenominator(conditionId)`: 0 until the condition is resolved. */
async function readPayoutDenominator(
  chain: ChainReader,
  conditionalTokens: Address,
  conditionId: ConditionId,
): Promise<bigint> {
  const what = 'ConditionalTokens.payoutDenominator';
  const result = await call(
    chain,
    conditionalTokens,
    encodeFunctionData({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'payoutDenominator',
      args: [conditionId],
    }),
    what,
  );
  return decoded(what, () =>
    decodeFunctionResult({
      abi: CONDITIONAL_TOKENS_ABI,
      functionName: 'payoutDenominator',
      data: result,
    }),
  );
}

// ---------------------------------------------------------------------------
// Input and answer checks
// ---------------------------------------------------------------------------

/** The trader's wallet type and address, checked. */
function checkTrader(identity: unknown): {
  type: 'eoa' | 'smart_wallet';
  address: Address;
} {
  if (!isObject(identity)) {
    throw new UserInputError('identity() must resolve to a trading identity');
  }
  const { type } = identity;
  if (type !== 'eoa' && type !== 'smart_wallet') {
    throw new UserInputError('identity.type must be "eoa" or "smart_wallet"');
  }
  return {
    type,
    address: normalizeAddress(identity.address as string, 'identity.address'),
  };
}

function readSetupOptions(o: unknown): boolean {
  if (o === undefined) {
    return false;
  }
  if (!isObject(o)) {
    throw new UserInputError('options must be an object');
  }
  const { includeMarketManager } = o;
  if (includeMarketManager === undefined) {
    return false;
  }
  if (typeof includeMarketManager !== 'boolean') {
    throw new UserInputError('includeMarketManager must be true or false');
  }
  return includeMarketManager;
}

/** The requested token ids, canonical. A hole in the list is read as `undefined`, so it is refused. */
function readBalancesOptions(o: unknown): TokenId[] {
  if (o === undefined) {
    return [];
  }
  if (!isObject(o)) {
    throw new UserInputError('options must be an object');
  }
  const { tokenIds } = o;
  if (tokenIds === undefined) {
    return [];
  }
  if (!Array.isArray(tokenIds)) {
    throw new UserInputError('tokenIds must be an array of token ids');
  }
  return Array.from(tokenIds as unknown[], (id, index) =>
    normalizeTokenId(id, `tokenIds[${index}]`),
  );
}

/**
 * An amount in micro-units of `unit` (USDC for a transfer, shares for a merge; both have 6
 * decimals): a decimal string or a number of whole units, above 0, with at most 6 decimals,
 * that fits a uint256 once in micro-units. A bigint is refused: it could as well be
 * micro-units.
 */
function readAmount(amount: unknown, unit: 'USDC' | 'shares' = 'USDC'): bigint {
  if (typeof amount !== 'string' && typeof amount !== 'number') {
    throw new UserInputError(
      `amount must be a decimal string or a number of whole ${unit}, such as "5" or 0.5`,
    );
  }
  const micro = toMicro(amount, 'amount');
  if (micro === 0n) {
    throw new UserInputError('amount must be greater than 0');
  }
  if (micro > maxUint256) {
    throw new UserInputError(
      `amount is too large: in micro-${unit} it does not fit a uint256`,
    );
  }
  return micro;
}

/** A `/positions` field that is not what the gateway documents. Names the field, never the value. */
function unexpectedPositions(field: string, rule: string) {
  return unexpectedOrderbookAnswer('/positions', field, rule);
}

function wholeUnits(value: unknown, field: string): DecimalString {
  if (typeof value !== 'string' || !MICRO_UNITS.test(value)) {
    throw unexpectedPositions(
      field,
      'must be a non-negative integer of micro-units',
    );
  }
  return fromMicro(BigInt(value));
}

/** The `/positions` answer in whole units, every amount and token id checked. */
function orderbookView(answer: Positions): Balances['orderbook'] {
  const cash = wholeUnits(answer.cash_balance, 'cash_balance');
  if (!Array.isArray(answer.positions)) {
    throw unexpectedPositions('positions', 'must be an array');
  }
  const positions = answer.positions.map((entry, i) => {
    const field = `positions[${i}]`;
    let tokenId: TokenId;
    try {
      tokenId = normalizeTokenId(entry.token_id);
    } catch {
      throw unexpectedPositions(
        `${field}.token_id`,
        'must be a decimal uint256 token id',
      );
    }
    return {
      tokenId,
      balance: wholeUnits(entry.balance, `${field}.balance`),
      reserved: wholeUnits(entry.reserved, `${field}.reserved`),
    };
  });
  return { cash, positions };
}

/** `rail_not_configured`: a method that sends was called on an account client without a rail. */
function railNotConfigured(why: string): UserInputError {
  return new UserInputError(
    `${why}, but the client has no rail: pass the \`rail\` option (a TxRail such as SponsoredRail)`,
    { code: 'rail_not_configured' },
  );
}

/** The rail of each account client, for {@link preflightSend}: a registry, so no public member is added. */
const railOf = new WeakMap<object, TxRail | undefined>();

/**
 * Internal (not exported from the package). Runs the checks the sends of `account` would make
 * before their calls matter, without signing or sending anything: there is a rail
 * (`rail_not_configured`), and the rail's preflight passes (`preflightRail`): the rail would
 * not refuse the send for its configuration (`sponsor_not_configured`, `direct_rail_eoa_only`,
 * a signer that cannot sign a digest, a closed client); and on the sponsored rail no earlier
 * transaction of the owner may still land (two nonce reads: `previous_operation_pending`). The
 * bridge calls it before it confirms a withdrawal, so the funding claim, which is one-time, is
 * never spent on a transfer that cannot be made. An account client this module did not build
 * passes, and so does a custom rail that has no checks.
 *
 * @throws the error the send would throw for the same refusal, with `mayHaveLanded: false`.
 */
export async function preflightSend(
  account: unknown,
  why: string,
): Promise<void> {
  if (!isObject(account) || !railOf.has(account)) {
    return;
  }
  const rail = railOf.get(account);
  if (rail === undefined) {
    throw withLanded(railNotConfigured(why), false);
  }
  await preflightRail(rail);
}

/**
 * Runs the checks and reads that come before a send. Nothing was sent when one fails, so the
 * SDK error it raises (made for this call) leaves with `mayHaveLanded: false`, as a rail's
 * own errors do.
 */
async function beforeSend<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw error instanceof XoError ? withLanded(error, false) : error;
  }
}

// ---------------------------------------------------------------------------
// AccountClient
// ---------------------------------------------------------------------------

/**
 * The trader's account: balances, the one-time setup for trading, USDC transfers, and merging
 * and redeeming outcome tokens.
 *
 * Funds, approvals and outcome tokens live at the trading address (`identity.address`): the
 * owner's wallet for an EOA, the smart wallet for a smart wallet. Every amount, in and out, is
 * in whole units (USDC and outcome tokens both have 6 decimals); a raw-units string is refused
 * at compile time.
 *
 * The sending methods (`setup`, `transferUsdc`, `merge`, `redeem`, `redeemAll`) hand plain
 * calls to the rail, which wraps them for a smart wallet and deploys it first when needed.
 * Every error they throw carries `mayHaveLanded`: `false` for a check or a read before the
 * send (nothing was sent), and what the rail set for the send itself, whose errors propagate
 * unchanged (`redeemAll` reports them per market instead). An error of `identity()`
 * propagates as it is (nothing was sent either).
 *
 * **Composed.** It needs the trading identity of a session, a rail built for that same
 * identity, the chain reader and the orderbook client of that session. The secure client
 * composes all of them: `identity: () => session.identity()`, a rail built for that identity,
 * the session's `OrderbookClient`, and the chain reader both use.
 *
 * Internal: an engine behind the two clients. No entry of the package exports it.
 */
export class AccountClient {
  readonly #env: EnvironmentConfig;
  readonly #identity: () => Promise<TradingIdentity>;
  readonly #rail: TxRail | undefined;
  readonly #chain: ChainReader;
  readonly #orderbook: AccountOrderbook;
  readonly #data: AccountData | undefined;
  readonly #warn: (message: string) => void;

  /** @throws UserInputError if an option is missing or of the wrong kind. */
  constructor(o: AccountClientOptions) {
    if (!isObject(o)) {
      throw new UserInputError('options must be an object');
    }
    const { env, identity, rail, chain, orderbook, data, warn } =
      o as Partial<AccountClientOptions>;
    if (!isObject(env) || !isObject(env.contracts)) {
      throw new UserInputError('env must be an environment config');
    }
    if (typeof identity !== 'function') {
      throw new UserInputError(
        'identity must be a function that resolves the trading identity',
      );
    }
    if (
      !isObject(chain) ||
      typeof chain.readContract !== 'function' ||
      typeof chain.getCode !== 'function'
    ) {
      throw new UserInputError(
        'chain must be a ChainReader (readContract, getCode)',
      );
    }
    if (
      !isObject(orderbook) ||
      typeof orderbook.getPositions !== 'function' ||
      typeof orderbook.getMarketCapacity !== 'function' ||
      typeof orderbook.getClaimable !== 'function'
    ) {
      throw new UserInputError(
        'orderbook must be an OrderbookClient (getPositions, getMarketCapacity, getClaimable)',
      );
    }
    if (
      data !== undefined &&
      (!isObject(data) ||
        !isObject(data.portfolio) ||
        typeof data.portfolio.redeemable !== 'function')
    ) {
      throw new UserInputError(
        'data must be a DataClient (portfolio.redeemable)',
      );
    }
    if (warn !== undefined && typeof warn !== 'function') {
      throw new UserInputError('warn must be a function');
    }
    if (
      rail !== undefined &&
      (!isObject(rail) || typeof rail.send !== 'function')
    ) {
      throw new UserInputError('rail must be a TxRail (send)');
    }
    this.#env = env;
    this.#identity = identity;
    this.#rail = rail;
    railOf.set(this, rail);
    this.#chain = chain;
    this.#orderbook = orderbook;
    this.#data = data;
    this.#warn = warn ?? ((message) => console.warn(message));
  }

  /**
   * The trader's balances: USDC and outcome tokens on chain at the trading address, and the
   * orderbook's view (`GET /positions`: cash, and per token the balance and the shares
   * reserved by resting SELL orders). Every amount is a whole-unit decimal string.
   *
   * The tokens read on chain are `o.tokenIds` and every token of `/positions`, without
   * duplicates, with `ConditionalTokens.balanceOfBatch` (one call per 500 ids); each gets an
   * entry, `'0'` included.
   * What is free to commit per market is `orderbook.getMarketCapacity(conditionId)`.
   *
   * There is no partial result: any failure rejects the whole call.
   * @throws UserInputError for a bad `tokenIds` entry, before anything is read.
   * @throws the orderbook client's error, unchanged, when `/positions` fails.
   * @throws UnexpectedResponseError (service `orderbook`) when a `/positions` amount is not micro-units or a token id is not one.
   * @throws XoError `chain_read_failed` (service `chain`) when a chain read fails or does not decode.
   */
  async getBalances(o?: BalancesOptions): Promise<Balances> {
    const requested = readBalancesOptions(o);
    const { address } = checkTrader(await this.#identity());
    const { usdc, conditionalTokens } = this.#env.contracts;
    const [positions, usdcMicro] = await Promise.all([
      this.#orderbook.getPositions(),
      readUsdcBalance(this.#chain, usdc, address),
    ]);
    const view = orderbookView(positions);
    const ids = [
      ...new Set([...requested, ...view.positions.map((p) => p.tokenId)]),
    ];
    const amounts =
      ids.length === 0
        ? []
        : await readTokenBalances(this.#chain, conditionalTokens, address, ids);
    const tokens: Record<string, DecimalString> = {};
    ids.forEach((id, i) => {
      tokens[id] = fromMicro(amounts[i] as bigint);
    });
    return { usdc: fromMicro(usdcMicro), tokens, orderbook: view };
  }

  /**
   * Sets the account up for trading, idempotently: it reads what is missing and sends it all
   * in **one** transaction, or nothing at all. The steps, always in this order:
   *
   * - `deploy`: a smart wallet without code. The rail prepends the factory's
   *   `createAccount` to the batch; `setup` only reports it. A codeless smart wallet has no
   *   approvals, so none are read: they are all sent.
   * - `approve_usdc`: `USDC.approve(CTFExchange, max)` when the allowance is below 2^255.
   * - `approve_ctf`: `ConditionalTokens.setApprovalForAll(CTFExchange, true)` when not set.
   * - `approve_manager`: only with `includeMarketManager: true` (default `false`),
   *   `USDC.approve(ClobMarketManager, max)` when that allowance is below 2^255.
   *
   * Empty `actions` means nothing was sent and there is no `txHash`. The actions are worked
   * out before the rail is needed, so a client without a rail can still confirm an account is
   * set up; it throws `rail_not_configured` only when something must be sent.
   *
   * One transaction needs a rail that batches. The sponsored rail does, for either wallet type
   * (on an environment with a `sponsorUrl`, leave the secure client's `rail` option out);
   * a `DirectRail` (`rail: 'direct'`) sends one call per transaction, so a setup of two or more
   * actions fails on it with `direct_rail_single_call` and nothing is sent.
   * @throws UserInputError if `o` is not `{ includeMarketManager?: boolean }`; `rail_not_configured` (naming the actions) when something must be sent and there is no rail.
   * @throws XoError `chain_read_failed` when a read fails. Nothing was sent (`mayHaveLanded: false`).
   * @throws TransactionFailedError `tx_reverted` (with `transactionHash`, `mayHaveLanded: false`) when the transaction was mined but reverted. `setup()` re-reads the chain, so calling it again is the way to retry.
   * @throws the rail's error, unchanged, when the send fails: check `mayHaveLanded` before calling again.
   */
  async setup(o?: SetupOptions): Promise<SetupResult> {
    const { actions, receipt } = await this.setupTransaction(o);
    return receipt === undefined
      ? { actions: [] }
      : { txHash: receipt.txHash, actions };
  }

  /**
   * {@link setup}, with the mined transaction's receipt instead of its hash: `receipt` is
   * absent when there was nothing to send. It throws as `setup()` does, a reverted setup
   * included.
   *
   * @internal
   */
  async setupTransaction(
    o?: SetupOptions,
  ): Promise<{ actions: SetupAction[]; receipt?: TxResult }> {
    const includeManager = await beforeSend(() => readSetupOptions(o));
    const identity = await this.#identity();
    const { actions, calls } = await beforeSend(() =>
      this.#plan(identity, includeManager),
    );
    if (actions.length === 0) {
      return { actions: [] };
    }
    const rail = await beforeSend(() =>
      this.#requireRail(
        `setupTradingApprovals() must send ${actions.join(', ')}`,
      ),
    );
    const result = await rail.send(calls);
    if (result.status === 'reverted') {
      throw new TransactionFailedError(
        `The setup transaction ${result.txHash} (${actions.join(', ')}) was mined but reverted, so the account may not be set up. Creating the client again, or calling setupTradingApprovals(), is safe: both read the on-chain state again and send only what is missing`,
        {
          mayHaveLanded: false,
          transactionHash: result.txHash,
          code: 'tx_reverted',
          service: 'chain',
        },
      );
    }
    return { actions, receipt: result };
  }

  /**
   * Sends `amount` USDC from the trading address to `to`, as one transaction on the rail.
   *
   * `amount` is whole USDC (`'5'` is 5 USDC, sent as 5 000 000 micro-USDC), above 0 with at
   * most 6 decimals, converted exactly. A raw-units string is refused at compile time, and a
   * bigint at run time. `to` may be neither the zero address nor the USDC contract. The USDC
   * balance is read first: when it is short nothing is sent.
   *
   * Resolves with the rail's result as it is: a reverted transaction is a result
   * (`status: 'reverted'`), not an error.
   * @throws UserInputError for a bad `to`, the zero address, the USDC contract (`recipient_is_token_contract`) or a bad amount, and `rail_not_configured` without a rail, all before anything is read; `insufficient_balance` (naming both amounts) when the balance is short. `mayHaveLanded: false`.
   * @throws XoError `chain_read_failed` (`mayHaveLanded: false`) when the balance read fails.
   * @throws the rail's error, unchanged, when the send fails: when `mayHaveLanded` is true, never send again before reconciling.
   */
  async transferUsdc<A extends string | number>(
    to: Address,
    amount: WholeUnits<A>,
  ): Promise<TxResult> {
    const { recipient, micro, rail } = await beforeSend(() => {
      const recipient = normalizeAddress(to as string, 'to');
      if (recipient === zeroAddress) {
        throw new UserInputError(
          'to must not be the zero address: USDC sent there is lost',
        );
      }
      if (isSameAddress(recipient, this.#env.contracts.usdc)) {
        throw new UserInputError(
          'to must not be the USDC contract itself: USDC sent to the token contract is lost',
          { code: 'recipient_is_token_contract' },
        );
      }
      return {
        recipient,
        micro: readAmount(amount),
        rail: this.#requireRail('transferErc20() sends a transaction'),
      };
    });
    const identity = await this.#identity();
    const usdc = this.#env.contracts.usdc;
    await beforeSend(async () => {
      const { address } = checkTrader(identity);
      const balance = await readUsdcBalance(this.#chain, usdc, address);
      if (balance < micro) {
        throw new UserInputError(
          `The USDC balance of ${address} is ${fromMicro(balance)}, less than the ${fromMicro(micro)} to transfer: nothing was sent`,
          { code: 'insufficient_balance' },
        );
      }
    });
    return rail.send([
      {
        to: usdc,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [recipient, micro],
        }),
        value: 0n,
      },
    ]);
  }

  /**
   * Sends `amount` of the ERC-20 token at `token` from the trading address to `to`, as one
   * `transfer` on the rail. For XO's USDC use {@link transferUsdc}, which knows its decimals.
   *
   * `amount` is in whole units of the token: its `decimals()` is read from the chain first, and
   * the amount is converted exactly, with at most that many decimals and above 0. A raw-units
   * string is refused at compile time, and a bigint at run time. `to` may be neither the zero
   * address nor the token contract. The token balance is read next: when it is short nothing is
   * sent.
   *
   * Resolves with the rail's result as it is: a reverted transaction is a result
   * (`status: 'reverted'`), not an error.
   * @throws UserInputError for a bad `token` or `to`, the zero address, the token contract (`recipient_is_token_contract`) or an amount that is neither a decimal string nor a number, and `rail_not_configured` without a rail, all before anything is read; a bad amount for the token's decimals, and `insufficient_balance` (naming both amounts) when the balance is short. `mayHaveLanded: false`.
   * @throws XoError `chain_read_failed` (`mayHaveLanded: false`) when the decimals or the balance cannot be read, as for an address that is not an ERC-20 token.
   * @throws the rail's error, unchanged, when the send fails: when `mayHaveLanded` is true, never send again before reconciling.
   * @internal
   */
  async transferErc20<A extends string | number>(
    token: Address,
    to: Address,
    amount: WholeUnits<A>,
  ): Promise<TxResult> {
    const { contract, recipient, rail } = await beforeSend(() => {
      const contract = normalizeAddress(token as string, 'token');
      if (contract === zeroAddress) {
        throw new UserInputError(
          'token must be the address of an ERC-20 token, not the zero address',
        );
      }
      const recipient = normalizeAddress(to as string, 'to');
      if (recipient === zeroAddress) {
        throw new UserInputError(
          'to must not be the zero address: tokens sent there are lost',
        );
      }
      if (isSameAddress(recipient, contract)) {
        throw new UserInputError(
          'to must not be the token contract itself: tokens sent to the token contract are lost',
          { code: 'recipient_is_token_contract' },
        );
      }
      if (typeof amount !== 'string' && typeof amount !== 'number') {
        throw new UserInputError(
          'amount must be a decimal string or a number of whole tokens, such as "5" or 0.5',
        );
      }
      return {
        contract,
        recipient,
        rail: this.#requireRail('transferErc20() sends a transaction'),
      };
    });
    const identity = await this.#identity();
    const units = await beforeSend(async () => {
      const { address } = checkTrader(identity);
      const decimals = await readDecimals(this.#chain, contract);
      const wanted = toUnits(amount, decimals, 'amount');
      if (wanted === 0n) {
        throw new UserInputError('amount must be greater than 0');
      }
      if (wanted > maxUint256) {
        throw new UserInputError(
          "amount is too large: in the token's base units it does not fit a uint256",
        );
      }
      const balance = await readTokenBalance(this.#chain, contract, address);
      if (balance < wanted) {
        throw new UserInputError(
          `The balance of ${address} in token ${contract} is ${fromUnits(balance, decimals)}, less than the ${fromUnits(wanted, decimals)} to transfer: nothing was sent`,
          { code: 'insufficient_balance' },
        );
      }
      return wanted;
    });
    return rail.send([
      {
        to: contract,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [recipient, units],
        }),
        value: 0n,
      },
    ]);
  }

  /**
   * The steps {@link setup} would send now, in the order it sends them, without sending
   * anything or needing a rail: empty when the account is set up. Internal: the trading
   * approvals read builds its state from it.
   *
   * @throws UserInputError if `o` is not `{ includeMarketManager?: boolean }`.
   * @throws XoError `chain_read_failed` when a read fails.
   * @internal
   */
  async setupPlan(o?: SetupOptions): Promise<SetupAction[]> {
    const includeManager = readSetupOptions(o);
    const identity = await this.#identity();
    const { actions } = await this.#plan(identity, includeManager);
    return actions;
  }

  /**
   * Whether the trading account exists on chain. For a smart wallet: whether it has code
   * (`getCode(identity.address)` is neither `'0x'` nor `'0x0'`, the same test the rail uses
   * to prepend the deploy); `setup()` deploys it. For an EOA always `true`, with nothing
   * read: a wallet needs no deployment.
   * @throws XoError `chain_read_failed` (service `chain`) when the code read fails.
   */
  async isDeployed(): Promise<boolean> {
    const { type, address } = checkTrader(await this.#identity());
    return type === 'eoa' || hasCode(this.#chain, address);
  }

  /**
   * Merges YES and NO shares of one market back into USDC: `amount` YES and `amount` NO are
   * burnt for `amount` USDC, at the trading address, in one transaction on the rail
   * (`ConditionalTokens.mergePositions(USDC, bytes32(0), conditionId, [1, 2], amount)`).
   *
   * What may be merged is what the orderbook says is free (`getMarketCapacity`): per outcome,
   * the balance less the shares reserved by resting SELL orders and pending settlement. YES
   * and NO are found by their outcome label. Without `amount` all of it is merged:
   * `min(free YES, free NO)`. `amount` is whole shares (`'5'` is 5 000 000 micro-shares),
   * above 0 with at most 6 decimals, converted exactly; a raw-units string is refused at
   * compile time, and a bigint at run time.
   *
   * **Pause quoting first.** The free amount is read once, before the send: an order placed
   * or matched between that read and the merge can be left without the shares it needs, and
   * then fail at settlement. Cancel or stop the orders of this market before merging.
   *
   * Resolves with the rail's result as it is: a reverted transaction is a result
   * (`status: 'reverted'`), not an error.
   * @throws UserInputError for a bad `conditionId` or `amount`, and `rail_not_configured` without a rail, all before anything is read; for an `identity()` that does not resolve to a trading identity; `nothing_to_merge` when the orderbook lists no YES or no NO position there (a market it does not know) or 0 of one is free; `amount_exceeds_free` (naming the free amount) when `amount` is above it. `mayHaveLanded: false`.
   * @throws the orderbook client's error, with `mayHaveLanded: false`, when the capacity read fails; UnexpectedResponseError (service `orderbook`) when its answer lists an outcome other than YES and NO, one twice, or a `free_position` that is not micro-units.
   * @throws the rail's error, unchanged, when the send fails: when `mayHaveLanded` is true, never send again before reconciling.
   */
  merge(conditionId: ConditionId | string): Promise<TxResult>;
  merge<A extends string | number>(
    conditionId: ConditionId | string,
    amount: WholeUnits<A>,
  ): Promise<TxResult>;
  // Its own overload: as an optional parameter, `WholeUnits<A> | undefined` would refuse a
  // plain `string | number` amount (TypeScript infers A from one member of the union only).
  merge<A extends string | number>(
    conditionId: ConditionId | string,
    amount: WholeUnits<A> | undefined,
  ): Promise<TxResult>;
  async merge(
    conditionId: ConditionId | string,
    amount?: string | number,
  ): Promise<TxResult> {
    const { market, requested, rail } = await beforeSend(() => ({
      market: normalizeConditionId(conditionId),
      requested:
        amount === undefined ? undefined : readAmount(amount, 'shares'),
      rail: this.#requireRail('mergePositions() sends a transaction'),
    }));
    const identity = await this.#identity();
    const micro = await beforeSend(async () => {
      checkTrader(identity);
      const capacity = await this.#orderbook.getMarketCapacity(market);
      return mergeAmount(capacity, market, requested);
    });
    return rail.send([mergeCall(this.#env.contracts, market, micro)]);
  }

  /**
   * Redeems the trading address's YES and NO shares of one resolved market for what they pay
   * out, in one transaction on the rail
   * (`ConditionalTokens.redeemPositions(USDC, bytes32(0), conditionId, [1, 2])`).
   *
   * The condition must be resolved on chain: `ConditionalTokens.payoutDenominator` is read
   * first, and while it is 0 nothing is sent. A redeem with no shares is not refused: it
   * pays 0.
   *
   * Resolves with the rail's result as it is: a reverted transaction is a result
   * (`status: 'reverted'`), not an error.
   * @throws UserInputError for a bad `conditionId`, and `rail_not_configured` without a rail, both before anything is read; for an `identity()` that does not resolve to a trading identity; `not_resolved` when the payout denominator is 0. `mayHaveLanded: false`.
   * @throws XoError `chain_read_failed` (`mayHaveLanded: false`) when the resolution read fails.
   * @throws the rail's error, unchanged, when the send fails: when `mayHaveLanded` is true, never send again before reconciling.
   */
  async redeem(conditionId: ConditionId | string): Promise<TxResult> {
    const { market, rail } = await beforeSend(() => ({
      market: normalizeConditionId(conditionId),
      rail: this.#requireRail('redeem() sends a transaction'),
    }));
    const identity = await this.#identity();
    await beforeSend(() => checkTrader(identity));
    return this.#redeemOne(rail, market);
  }

  /**
   * Redeems every market the trader can redeem, one transaction per market, one after
   * another, and reports each market.
   *
   * The markets are the orderbook's claimable ones (`getClaimable()`) and, when the client
   * has the `data` option, the CLOB markets of the trader's `portfolio.redeemable()` (types
   * 2, 3 and 4; standard LMSR and pulse markets, types 0 and 1, settle on their own contracts
   * and are left out), without duplicates: the orderbook's first, then the data client's,
   * each in the order first seen. At most 1000 data positions (`MAX_REDEEMABLE_SCAN`) are
   * read, largest claim first; when there are more, `warn` is called once, and calling
   * `redeemAll()` again after these redemptions land picks up more. For each, the same check and call as
   * {@link redeem}: an unresolved market is a `not_resolved` error for that market only.
   *
   * One market failing does not stop the others, with one exception. When a send may have
   * landed (an error whose `mayHaveLanded` is not `false`), it is recorded and nothing more
   * is sent: another transaction could take the nonce of the unknown one. Every market after
   * it gets a `TransactionFailedError` `skipped_after_ambiguous` (`mayHaveLanded: false`);
   * reconcile, then call `redeemAll()` again. A reverted transaction is a `result`.
   *
   * Every entry has `result` or `error`. Empty when there is nothing to redeem.
   * @throws UserInputError `rail_not_configured` without a rail, before anything is read; for an `identity()` that does not resolve to a trading identity, before the markets are read. `mayHaveLanded: false`.
   * @throws the orderbook client's or the data client's error, with `mayHaveLanded: false`, when reading the markets fails: the whole call fails before anything is sent. UnexpectedResponseError (service `orderbook`) when a claimable `market_id` is not a condition id.
   */
  async redeemAll(): Promise<RedeemAllEntry[]> {
    const rail = await beforeSend(() =>
      this.#requireRail('redeemAllPositions() sends transactions'),
    );
    const identity = await this.#identity();
    const { conditionIds, truncated } = await beforeSend(() => {
      checkTrader(identity);
      return redeemCandidates(this.#orderbook, this.#data);
    });
    if (truncated) {
      this.#emitWarn(truncationWarning());
    }
    return redeemEach(conditionIds, (market) => this.#redeemOne(rail, market));
  }

  /** Calls `warn`. A callback that throws must not break the operation. */
  #emitWarn(message: string): void {
    try {
      this.#warn(message);
    } catch {
      // Ignored, as the session does.
    }
  }

  /** The redeem of one market: checks it is resolved, then sends. */
  async #redeemOne(rail: TxRail, market: ConditionId): Promise<TxResult> {
    const contracts = this.#env.contracts;
    await beforeSend(async () => {
      const denominator = await readPayoutDenominator(
        this.#chain,
        contracts.conditionalTokens,
        market,
      );
      if (denominator === 0n) {
        throw new UserInputError(
          `The market ${market} is not resolved on chain (its payoutDenominator is 0), so there is nothing to redeem yet. Nothing was sent`,
          { code: 'not_resolved' },
        );
      }
    });
    return rail.send([redeemCall(contracts, market)]);
  }

  /** What `setup()` must send for `identity`: the actions and their calls, in order. */
  async #plan(
    identity: unknown,
    includeManager: boolean,
  ): Promise<{ actions: SetupAction[]; calls: Call[] }> {
    const { type, address } = checkTrader(identity);
    const { usdc, ctfExchange, conditionalTokens, clobMarketManager } =
      this.#env.contracts;
    const chain = this.#chain;
    const deployed = type === 'eoa' || (await hasCode(chain, address));

    let needs: { usdc: boolean; ctf: boolean; manager: boolean };
    if (deployed) {
      const [exchangeAllowance, operatorApproved, managerAllowance] =
        await Promise.all([
          readAllowance(chain, usdc, address, ctfExchange),
          readOperatorApproval(chain, conditionalTokens, address, ctfExchange),
          includeManager
            ? readAllowance(chain, usdc, address, clobMarketManager)
            : undefined,
        ]);
      needs = {
        usdc: exchangeAllowance < LOW_ALLOWANCE,
        ctf: !operatorApproved,
        manager:
          managerAllowance !== undefined && managerAllowance < LOW_ALLOWANCE,
      };
    } else {
      // No code, so no approvals: they are known to be missing.
      needs = { usdc: true, ctf: true, manager: includeManager };
    }

    const actions: SetupAction[] = deployed ? [] : ['deploy'];
    const calls: Call[] = [];
    if (needs.usdc) {
      actions.push('approve_usdc');
      calls.push(approveMax(usdc, ctfExchange));
    }
    if (needs.ctf) {
      actions.push('approve_ctf');
      calls.push({
        to: conditionalTokens,
        data: encodeFunctionData({
          abi: CONDITIONAL_TOKENS_ABI,
          functionName: 'setApprovalForAll',
          args: [ctfExchange, true],
        }),
        value: 0n,
      });
    }
    if (needs.manager) {
      actions.push('approve_manager');
      calls.push(approveMax(usdc, clobMarketManager));
    }
    return { actions, calls };
  }

  /** The rail. @throws UserInputError `rail_not_configured` without one; `why` says what needed it. */
  #requireRail(why: string): TxRail {
    if (this.#rail === undefined) {
      throw railNotConfigured(why);
    }
    return this.#rail;
  }
}

/** `USDC.approve(spender, max)`. */
function approveMax(usdc: Address, spender: Address): Call {
  return {
    to: usdc,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, maxUint256],
    }),
    value: 0n,
  };
}
