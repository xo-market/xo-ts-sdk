// Plumbing shared by the orderbook client (client.ts) and its trading (trading.ts) and
// own-data (account.ts) parts. Internal: not re-exported from any barrel.

import type { Address, Hex } from 'viem';
import type { Session } from '../auth/session';
import {
  type SessionInternals,
  sessionInternals,
} from '../auth/sessionInternal';
import type { EnvironmentConfig } from '../core/env';
import { AuthRequiredError, UserInputError } from '../core/errors';
import type { DualSchema } from '../core/schema';
import type { TransportRequest } from '../core/transport';
import type { TradingIdentity } from '../wallet/identity';
import type { InternalSigner } from '../wallet/signer';

/**
 * The part of the chain access the orderbook client needs: reading a contract. The full
 * `ChainReader` of `../account/chain` extends this interface, so one `createChainReader(env)`
 * serves the orderbook client, `resolveMarket` and the transaction rails.
 */
export interface ContractReader {
  /** A read-only `eth_call` of `data` on contract `to`; resolves with the raw return data. */
  readContract(call: { to: Address; data: Hex }): Promise<Hex>;
}

/** What the trading and own-data parts get from the client. */
export interface OrderbookDeps {
  /** Sends one orderbook request and checks the answer against `schema`. */
  send<T>(
    schema: DualSchema<T>,
    o: Omit<TransportRequest, 'service'>,
  ): Promise<T>;
  /**
   * Sends one orderbook request and returns the decoded answer unchecked. Placement uses it
   * with {@link OrderbookDeps.parse} so a failure after the gateway answered is told apart.
   */
  request(o: Omit<TransportRequest, 'service'>): Promise<unknown>;
  /** Checks an answer against `schema` (`path` without a query). */
  parse<T>(schema: DualSchema<T>, data: unknown, path: string): T;
  readonly env: EnvironmentConfig;
  readonly session: Session | undefined;
  readonly chain: ContractReader | undefined;
  /** The market's tick size (`getTickSize`), uncached. */
  tickSize(tokenId: string): Promise<string>;
  /** The local clock in milliseconds (the tick-size cache). */
  now(): number;
}

const NO_SESSION =
  'This call signs or reads as the trader, but the client has no session: pass the `session` option';
const NO_SIGNER =
  'This call signs as the trader, but the session has no signer: pass the `signer` option to the session';

/**
 * The client's session.
 * @throws AuthRequiredError when it has none. UserInputError when it is not a Session.
 */
export function requireSession(deps: OrderbookDeps): Session {
  const session = deps.session;
  if (session === undefined) {
    throw new AuthRequiredError(NO_SESSION);
  }
  if (
    typeof session !== 'object' ||
    session === null ||
    sessionInternals(session) === undefined
  ) {
    throw new UserInputError('session must be a Session of @xomarket/client');
  }
  return session;
}

/** Who trades, with the signer and the server clock. @throws AuthRequiredError without a session or a signer. */
export async function trader(deps: OrderbookDeps): Promise<{
  identity: TradingIdentity;
  signer: InternalSigner;
  nowSec: () => number;
}> {
  const session = requireSession(deps);
  // Registered: requireSession checked it.
  const { signer, clock } = sessionInternals(session) as SessionInternals;
  if (signer === undefined) {
    throw new AuthRequiredError(NO_SIGNER);
  }
  const identity = await session.identity();
  return { identity, signer, nowSec: () => clock.nowSec() };
}

/**
 * Checks that `value` is an object whose keys are all in `allowed`. A key outside the list
 * is refused, because the gateway refuses unknown fields too, and ignoring it
 * would hide a mistake, such as a `maker` filter the routes must not get.
 */
export function closedObject(
  value: unknown,
  field: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UserInputError(`${field} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new UserInputError(
        `${field} has an unknown key "${key.slice(0, 40)}" (allowed: ${allowed.join(', ')})`,
      );
    }
  }
  return value as Record<string, unknown>;
}

const ORDER_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ORDER_ID_PATTERN = /^[0-9]{1,20}$/;
const U64_MAX = (1n << 64n) - 1n;

/**
 * An order reference: an order hash (`0x` and 64 hex digits, returned in lower case) or a
 * legacy numeric order id (a u64 as decimal digits, returned without leading zeros).
 *
 * @throws {UserInputError} When `value` is neither.
 */
export function readOrderRef(value: unknown, field: string): string {
  if (typeof value === 'string') {
    if (ORDER_HASH_PATTERN.test(value)) {
      return value.toLowerCase();
    }
    if (ORDER_ID_PATTERN.test(value) && BigInt(value) <= U64_MAX) {
      return BigInt(value).toString();
    }
  }
  throw new UserInputError(
    `${field} must be an order hash (0x and 64 hex characters) or a numeric order id`,
  );
}

/** Whether a reference from {@link readOrderRef} is a numeric order id. */
export const isNumericRef = (ref: string): boolean => !ref.startsWith('0x');
