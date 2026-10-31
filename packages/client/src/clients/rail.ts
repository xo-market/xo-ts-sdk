import type { ChainReader, TxResult } from '../account/chain';
import { withLanded } from '../account/internal';
import {
  DirectRail,
  preflightRail,
  registerPreflight,
  type SendOptions,
  SponsoredRail,
  type TxRail,
} from '../account/rails';
import type { EnvironmentConfig } from '../core/env';
import {
  AuthRequiredError,
  TransactionFailedError,
  XoError,
} from '../core/errors';
import type { Transport } from '../core/transport';
import type { Call } from '../signing/kernel';
import type { TradingIdentity } from '../wallet/identity';
import { errorName } from '../wallet/internal';
import type { InternalSigner } from '../wallet/signer';

/**
 * Which rail the secure client sends on. `'sponsored'` and `'direct'` are what the `rail`
 * option names. `'auto'` is the default, when the option is left out: the sponsored rail, for
 * both wallet types (see `SessionRail`).
 */
export type RailKind = 'auto' | 'sponsored' | 'direct';

export interface SessionRailOptions {
  kind: RailKind;
  env: EnvironmentConfig;
  /**
   * The trading identity of the client's one session: the same function the account client
   * reads with, so both always act for one account.
   */
  identity: () => Promise<TradingIdentity>;
  /** Whether the client is still open. A closed client sends nothing. */
  isOpen: () => boolean;
  /** The session's signer, the owner that signs as executor. */
  signer: InternalSigner | undefined;
  chain: ChainReader;
  /** The client's transport, for the sponsor request (`X-XO-SDK`, `onRateLimit`). */
  transport: Transport;
}

/**
 * The secure client's rail: a {@link TxRail} built lazily from the session's
 * trading identity, the very identity the account client reads.
 *
 * Each send checks that the client is open, resolves the identity, checks again, then sends on
 * the concrete rail for it. The concrete rail is built once per identity and kept: the session
 * resolves its identity once, so in practice one rail per client, and a smart wallet's rail
 * keeps its memory that the smart wallet is deployed. A failure before the concrete rail runs
 * (a closed client, no signer, an RPC outage while the smart wallet address is looked up)
 * leaves with `mayHaveLanded: false`: nothing was sent.
 *
 * The concrete rail follows `kind`, whatever the identity and the environment: `'direct'` is a
 * `DirectRail`, and `'sponsored'` and `'auto'` are a `SponsoredRail`. `production` has
 * a `sponsorUrl`, so `'auto'` sends through XO's sponsor there, for both wallet types; on an
 * environment without one, the `SponsoredRail` refuses with `sponsor_not_configured`.
 */
export class SessionRail implements TxRail {
  readonly #o: SessionRailOptions;
  #cached: { identity: TradingIdentity; rail: TxRail } | undefined;

  constructor(o: SessionRailOptions) {
    this.#o = o;
    registerPreflight(this, () => this.#preflight());
  }

  /** See {@link TxRail}. */
  async send(calls: Call[], o?: SendOptions): Promise<TxResult> {
    let rail: TxRail;
    try {
      this.#assertOpen();
      const identity = await this.#o.identity();
      // close() may have started while the identity was resolving.
      this.#assertOpen();
      rail = this.#railFor(identity);
    } catch (error) {
      throw notSent(error);
    }
    return rail.send(calls, o);
  }

  /**
   * The checks `send` makes before its calls matter, without sending: the client is open, the
   * identity resolves, the concrete rail can be built for it, and that rail's own preflight
   * passes (the sponsored rail needs a `sponsorUrl`, the direct rail an EOA, both a signer that
   * signs a digest; the sponsored rail also reads whether an earlier transaction of the owner
   * may still land). Internal: reached through `preflightRail`, so that a caller can learn that
   * a send cannot be made before it spends something one-time.
   */
  async #preflight(): Promise<void> {
    let rail: TxRail;
    try {
      this.#assertOpen();
      const identity = await this.#o.identity();
      this.#assertOpen();
      rail = this.#railFor(identity);
    } catch (error) {
      throw notSent(error);
    }
    await preflightRail(rail);
  }

  #assertOpen(): void {
    if (!this.#o.isOpen()) {
      throw new XoError(
        'The client is closed: create a new one with createSecureClient. Nothing was sent',
        { code: 'session_closed' },
      );
    }
  }

  #railFor(identity: TradingIdentity): TxRail {
    const cached = this.#cached;
    if (cached !== undefined && cached.identity === identity) {
      return cached.rail;
    }
    const { kind, env, signer, chain, transport } = this.#o;
    if (signer === undefined) {
      throw new AuthRequiredError(
        'Sending a transaction needs a wallet: pass the `signer` option',
      );
    }
    const options = { env, identity, signer, chain };
    // 'sponsored' and 'auto' are both the sponsored rail (see SessionRail).
    const rail =
      kind === 'direct'
        ? new DirectRail(options)
        : new SponsoredRail({ ...options, transport });
    this.#cached = { identity, rail };
    return rail;
  }
}

/** An error from before anything was sent, with `mayHaveLanded: false` as a rail's are. */
function notSent(error: unknown): XoError {
  if (error instanceof XoError) {
    return withLanded(error, false);
  }
  return new TransactionFailedError(
    `The send failed before anything was sent (${errorName(error)}); nothing was sent`,
    { mayHaveLanded: false, code: 'send_failed' },
  );
}
