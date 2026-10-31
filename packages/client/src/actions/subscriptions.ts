import { z } from 'zod';
import type { ActionContext } from '../clients/context';
import { makeErrorGuard, UserInputError } from '../core/errors';
import { normalizeConditionId, normalizeTokenId } from '../core/ids';
import type { ConditionId, TokenId } from '../core/types';
import { conditionIdOf } from '../models/convert';
import {
  type ActivityEvent,
  type MarketTopicEvent,
  type PortfolioEvent,
  type SubscriptionEvent,
  type SubscriptionHandle,
  toActivityEvent,
  toLastTradePriceEvent,
  toMarketBookEvent,
  toPortfolioEvent,
  toPriceChangeEvent,
  toUserOrderEvent,
  toUserTradeEvent,
  type UserEvent,
} from '../models/realtime';
import {
  type MergeSource,
  mergeSubscriptions,
  sourceOf,
} from '../realtime/merged';
import type {
  MarketChannelEvent,
  UserChannelEvent,
} from '../realtime/orderbookFrames';
import type {
  MarketActivityChannelEvent,
  PortfolioChannelEvent,
} from '../realtime/socketio';
import type { Subscription } from '../realtime/subscription';
import { fields, parseInput } from './internal';

// One `subscribe` for every live topic. Each spec names a topic; the topics are opened on
// their sockets (the order book's market and user channels, the backend's portfolio and market
// activity channels) and merged into one handle whose events are the public models.
//
// - `market`: one market channel for every market spec of the call, by token (`assetIds`) and
//   by market (`markets`), split over several connections above 100 ids. The service follows
//   a token's whole market, so the events of other tokens are left out unless their market was
//   named.
// - `user`: the account's order and trade events, on every market (signed-in clients only).
// - `portfolio`: the account's positions, as `listPositions` lists them (the first 100 markets),
//   each time they change (signed-in clients only).
//
// Every signal of the handle names its topic: `'reconnected'` passes `{ topic }`, and an error
// carries `topic`, except `subscription_overflow`, which is about the whole handle.
// - `activity`: one market's newest fills, by XO's market id, each time it trades.

/** The `market` topic: the books, price changes and fills of outcome tokens or markets. */
export type MarketSubscriptionSpec = {
  /** `'market'`. */
  topic: 'market';
  /**
   * Outcome tokens, by id (the `assetId` of an order book). Their events only, even though the
   * service sends their market's.
   */
  assetIds?: readonly string[];
  /** Markets, by condition id: the events of every outcome token of each one. */
  markets?: readonly string[];
};

/** The `user` topic: the account's orders and trades, on every market. Signed-in clients only. */
export type UserSubscriptionSpec = {
  /** `'user'`. */
  topic: 'user';
};

/**
 * The `portfolio` topic: the account's positions, as `listPositions` lists them, each time they
 * change. Signed-in clients only.
 */
export type PortfolioSubscriptionSpec = {
  /** `'portfolio'`. */
  topic: 'portfolio';
};

/** The `activity` topic: the newest fills of one market each time it trades. */
export type ActivitySubscriptionSpec = {
  /** `'activity'`. */
  topic: 'activity';
  /** XO's id for the market (the `id` of a `Market`): digits. */
  marketId: string;
};

/** One topic of a subscription, and what to follow on it. */
export type SubscriptionSpec =
  | MarketSubscriptionSpec
  | UserSubscriptionSpec
  | PortfolioSubscriptionSpec
  | ActivitySubscriptionSpec;

/** The topics a client without a wallet can subscribe to: `market` and `activity`. */
export type PublicSubscriptionSpec =
  | MarketSubscriptionSpec
  | ActivitySubscriptionSpec;

/**
 * The specs as written, with every key their topic does not take typed `never`: a key a topic
 * does not know does not compile, as an option a call does not take does not.
 */
export type ExactSpecs<S extends readonly unknown[]> = {
  readonly [I in keyof S]: S[I] & {
    readonly [K in Exclude<
      keyof S[I],
      S[I] extends infer E
        ? E extends { topic: infer T }
          ? keyof Extract<SubscriptionSpec, { topic: T }>
          : never
        : never
    >]: never;
  };
};

/** The events a spec (or a union of specs) delivers. */
export type EventOf<S> = S extends { topic: 'market' }
  ? MarketTopicEvent
  : S extends { topic: 'user' }
    ? UserEvent
    : S extends { topic: 'portfolio' }
      ? PortfolioEvent
      : S extends { topic: 'activity' }
        ? ActivityEvent
        : never;

/**
 * The error union of `subscribe`: a `UserInputError` for specs that are not valid, a topic that
 * needs a signed-in client (`topic_needs_sign_in`), no WebSocket implementation, or a client
 * that is closed (`client_closed`).
 */
export type SubscribeError = UserInputError;
/** The guard of {@link SubscribeError}. */
export const SubscribeError = makeErrorGuard(UserInputError);

/** The error union of `closeSubscriptions`: `client_closed` on a closed signed-in client. */
export type CloseSubscriptionsError = UserInputError;
/** The guard of {@link CloseSubscriptionsError}. */
export const CloseSubscriptionsError = makeErrorGuard(UserInputError);

const LABEL = 'subscribe';
const TOPICS = ['market', 'user', 'portfolio', 'activity'] as const;
/** The topics that read the account: they need a signed-in client. */
const SIGNED_IN_TOPICS: ReadonlySet<string> = new Set(['user', 'portfolio']);
/** How many positions' markets a portfolio event holds: the most the service sends. */
const PORTFOLIO_MARKETS = 100;
/** How many fills an activity event holds: the most the service sends. */
const ACTIVITY_FILLS = 50;

const SCHEMAS = {
  market: z
    .strictObject({
      topic: z.literal('market'),
      assetIds: z
        .array(fields.assetId(), {
          error: 'must be a list of outcome token ids',
        })
        .optional(),
      markets: z
        .array(fields.conditionId(), {
          error: 'must be a list of condition ids',
        })
        .optional(),
    })
    .refine(
      (spec) =>
        (spec.assetIds?.length ?? 0) > 0 || (spec.markets?.length ?? 0) > 0,
      { error: 'needs assetIds or markets: at least one id' },
    ),
  user: z.strictObject({ topic: z.literal('user') }),
  portfolio: z.strictObject({ topic: z.literal('portfolio') }),
  activity: z.strictObject({
    topic: z.literal('activity'),
    marketId: fields.id(),
  }),
};

/** What one call subscribes to, every spec read and merged. */
interface Plan {
  assetIds: Set<TokenId>;
  markets: Set<ConditionId>;
  user: boolean;
  portfolio: boolean;
  activity: Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the specs: each one checked against its topic's closed schema, and all of them merged.
 *
 * @throws {UserInputError} `invalid_input` for specs that are not valid, `topic_needs_sign_in`
 *   for a topic of the account on a client without a wallet.
 */
function planOf(specs: unknown, signedIn: boolean): Plan {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new UserInputError(
      `${LABEL}: the specs must be a non-empty list of topics, such as [{ topic: 'market', assetIds }]`,
      { code: 'invalid_input' },
    );
  }
  const plan: Plan = {
    assetIds: new Set(),
    markets: new Set(),
    user: false,
    portfolio: false,
    activity: new Set(),
  };
  specs.forEach((spec: unknown, index) => {
    const at = `${LABEL}: specs[${index}]`;
    const topic = isRecord(spec) ? spec.topic : undefined;
    if (!TOPICS.includes(topic as (typeof TOPICS)[number])) {
      throw new UserInputError(
        `${at}.topic must be one of: ${TOPICS.join(', ')}`,
        { code: 'invalid_input' },
      );
    }
    if (!signedIn && SIGNED_IN_TOPICS.has(topic as string)) {
      throw new UserInputError(
        `${at}: the ${String(topic)} topic reads the account, so it needs a client signed in with a wallet: subscribe on a client from createSecureClient`,
        { code: 'topic_needs_sign_in' },
      );
    }
    switch (topic as (typeof TOPICS)[number]) {
      case 'market': {
        const read = parseInput(at, spec, SCHEMAS.market);
        for (const id of read.assetIds ?? []) {
          plan.assetIds.add(normalizeTokenId(id));
        }
        for (const id of read.markets ?? []) {
          plan.markets.add(normalizeConditionId(id));
        }
        return;
      }
      case 'user':
        parseInput(at, spec, SCHEMAS.user);
        plan.user = true;
        return;
      case 'portfolio':
        parseInput(at, spec, SCHEMAS.portfolio);
        plan.portfolio = true;
        return;
      case 'activity':
        plan.activity.add(parseInput(at, spec, SCHEMAS.activity).marketId);
        return;
    }
  });
  return plan;
}

type Source = MergeSource<SubscriptionEvent>;

/** The market channel of the plan's tokens and markets, keeping the events asked for. */
function marketSource(ctx: ActionContext, plan: Plan): Source {
  const { assetIds, markets } = plan;
  const wanted = (assetId: TokenId, market: ConditionId): boolean =>
    markets.has(market) || assetIds.has(assetId);
  const sub = ctx.realtime.orderbook().marketChannelOf({
    conditionIds: [...markets],
    assetIds: [...assetIds],
  });
  return sourceOf(
    'market',
    sub,
    'orderbook',
    ['book', 'price_change', 'last_trade_price'],
    (event: MarketChannelEvent): MarketTopicEvent | undefined => {
      switch (event.type) {
        case 'book': {
          const book = toMarketBookEvent(event);
          return wanted(book.assetId, book.market) ? book : undefined;
        }
        case 'price_change': {
          const all = markets.has(conditionIdOf(event.market));
          return toPriceChangeEvent(event, (id) => all || assetIds.has(id));
        }
        case 'last_trade_price': {
          const trade = toLastTradePriceEvent(event);
          return wanted(trade.assetId, trade.market) ? trade : undefined;
        }
        default:
          return undefined;
      }
    },
  );
}

/** The account's user channel, on every market. */
function userSource(ctx: ActionContext): Source {
  const sub = ctx.realtime.orderbook().userChannel({});
  return sourceOf(
    'user',
    sub,
    'orderbook',
    ['order', 'trade'],
    (event: UserChannelEvent): UserEvent | undefined => {
      switch (event.type) {
        case 'order':
          return toUserOrderEvent(event);
        case 'trade':
          return toUserTradeEvent(event);
        default:
          return undefined;
      }
    },
  );
}

/** The account's portfolio channel: the positions `listPositions` lists, in its first page. */
function portfolioSource(ctx: ActionContext): Source {
  const sub = ctx.realtime.backend().portfolioChannel({
    filters: { take: PORTFOLIO_MARKETS },
  });
  return sourceOf(
    'portfolio',
    sub as Subscription<PortfolioChannelEvent>,
    'backend',
    ['portfolio_snapshot'],
    toPortfolioEvent,
  );
}

/** One market's activity channel. */
function activitySource(ctx: ActionContext, marketId: string): Source {
  const sub = ctx.realtime.backend().marketActivityChannel({
    marketId: Number(marketId),
    filters: {
      take: ACTIVITY_FILLS,
      sortBy: 'executedAt',
      sortOrder: 'DESC',
    },
  });
  return sourceOf(
    'activity',
    sub as Subscription<MarketActivityChannelEvent>,
    'backend',
    ['market_activity_snapshot'],
    toActivityEvent,
  );
}

/**
 * Opens the plan's channels and merges them into one handle the client keeps. Nothing is
 * awaited, so a client that closes later always finds the handle. When a channel cannot be
 * opened, the ones opened before it are closed again.
 */
function open(
  ctx: ActionContext,
  specs: unknown,
  signedIn: boolean,
): SubscriptionHandle<SubscriptionEvent> {
  const plan = planOf(specs, signedIn);
  const sources: Source[] = [];
  try {
    if (plan.assetIds.size > 0 || plan.markets.size > 0) {
      sources.push(marketSource(ctx, plan));
    }
    if (plan.user) {
      sources.push(userSource(ctx));
    }
    if (plan.portfolio) {
      sources.push(portfolioSource(ctx));
    }
    for (const marketId of plan.activity) {
      sources.push(activitySource(ctx, marketId));
    }
  } catch (error) {
    for (const source of sources) {
      void source.sub.close();
    }
    throw error;
  }
  const { bufferSize } = ctx.realtime;
  const handle = mergeSubscriptions(
    sources,
    bufferSize === undefined ? {} : { bufferSize },
  );
  ctx.realtime.handles.add(handle);
  return handle;
}

/**
 * Subscribes to live topics of public data: `market` and `activity`. The topics of the account
 * are refused at once.
 *
 * The public documentation is on the `PublicClient` member `subscribe`.
 */
export async function subscribe<
  const S extends readonly PublicSubscriptionSpec[],
>(
  ctx: ActionContext,
  specs: S & ExactSpecs<S>,
): Promise<SubscriptionHandle<EventOf<S[number]>>> {
  return open(ctx, specs, false) as SubscriptionHandle<EventOf<S[number]>>;
}

/**
 * Subscribes to any live topic, the account's included.
 *
 * The public documentation is on the `SecureClient` member `subscribe`.
 */
export async function secureSubscribe<
  const S extends readonly SubscriptionSpec[],
>(
  ctx: ActionContext,
  specs: S & ExactSpecs<S>,
): Promise<SubscriptionHandle<EventOf<S[number]>>> {
  ctx.secure?.assertOpen();
  return open(ctx, specs, ctx.secure !== undefined) as SubscriptionHandle<
    EventOf<S[number]>
  >;
}

/**
 * Closes the subscriptions the client opened. A signed-in client refuses once it is closed.
 *
 * The public documentation is on the `PublicClient` member `closeSubscriptions`.
 */
export async function closeSubscriptions(ctx: ActionContext): Promise<void> {
  ctx.secure?.assertOpen();
  await ctx.realtime.handles.closeAll();
}
