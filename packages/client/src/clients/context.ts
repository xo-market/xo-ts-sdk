import type { ChainReader } from '../account/chain';
import type { AccountClient } from '../account/client';
import type { Session } from '../auth/session';
import type { BridgeClient } from '../bridge/client';
import type { Clock } from '../core/clock';
import type { EnvironmentConfig } from '../core/env';
import type { DataClient } from '../data/client';
import type { OrderbookClient } from '../orderbook/client';
import type { RealtimeHub } from '../realtime/merged';
import type { TradingIdentity } from '../wallet/identity';
import type { InternalSigner } from '../wallet/signer';

// The context every action runs on: the engines one client owns. A client builds its context
// once and hands it to each action as the first argument (`action.bind(null, ctx)`), so the
// actions themselves hold no state. Internal: no public barrel exports this module.

/**
 * What only a signed-in client holds. The secure client fills it in; the discovery actions
 * never read it, and the context of a public client leaves it out.
 */
export interface SecureParts {
  /** The session of the signed-in wallet: its API key and its order book credentials. */
  readonly session: Session;
  /**
   * The user's signer, converted once for the whole client: the session, the account, the rail
   * and the bridge all sign with this one object.
   */
  readonly signer: InternalSigner;
  /** Who trades: the plain wallet or the smart wallet the client resolved and checked. */
  readonly identity: TradingIdentity;
  /** On chain: balances, approvals, transfers, merge and redeem, sent through the rail. */
  readonly account: AccountClient;
  /** Deposits into XO and withdrawals out of it. */
  readonly bridge: BridgeClient;
  /**
   * Throws a `UserInputError` `client_closed` (`mayHaveLanded: false`) once the client is closed
   * or signed out. A secure action calls it before it signs or sends anything.
   */
  readonly assertOpen: () => void;
}

/** The engines one client owns, passed to every action as its first argument. */
export interface ActionContext {
  /** The environment the client was created for: its hosts and contracts. */
  env: EnvironmentConfig;
  /** The order book: market data, orders and trades. */
  orderbook: OrderbookClient;
  /** XO's market data: markets, events, series, accounts and rewards. */
  data: DataClient;
  /** Reads the chain. */
  chain: ChainReader;
  /** The server's clock, which an expiry check reads instead of the machine's. */
  clock: Clock;
  /** Whether a response field the SDK does not know is an error (for contract tests). */
  strict: boolean;
  /** The live subscriptions: the engines of the sockets and the open handles. */
  realtime: RealtimeHub;
  /** Set on the context of a secure client only. */
  secure?: SecureParts;
}
