import { HttpResponse, http } from 'msw';
import type { SetupServer } from 'msw/node';
import { testEnv } from './testEnv';

// A fake of the orderbook gateway's public market-data routes, for the msw tests of the
// OrderbookClient. It is written from the gateway's behaviour, not from the SDK, so a test that
// reads against it checks the SDK's requests against an independent version:
// - GET  /time                     -> a bare JSON number, unix seconds
// - GET  /tick-size?token_id       -> {minimum_tick_size: 0.001} (a JSON number); 404 "market not found"
// - GET  /trading-state            -> {state: "active" | "paused"}
// - GET  /book?token_id            -> a book (snake_case, padded prices); 404 for an unknown token
// - POST /books                    -> [book] for [{token_id}]; 404 on the first unknown token
// - GET  /midpoint?token_id        -> {mid}; POST /midpoints -> {token: mid}, unknown tokens omitted
// - GET  /price?token_id&side      -> {price}; POST /prices -> {token: {BUY?, SELL?}}, unknown omitted
// - GET  /spread?token_id          -> {spread}; POST /spreads -> {token: spread}, unknown omitted
// - GET  /last-trade-price?token_id -> {price, side}, default {"0.5", ""}; GET|POST
//   /last-trades-prices -> [{price, side, token_id}], tokens without a trade omitted
// - GET  /prices-history?token_id&interval&fidelity -> {history: [{t, p}]}, newest first
// - GET  /markets?next_cursor&limit -> {limit, count, next_cursor, data: [market]}; the cursor
//   is base64(offset) and the end is "LTE="; limit outside 1..500 is a 400
// - GET  /markets/{condition_id}   -> a market; GET /conviction/markets/{condition_id} -> a
//   market with its conviction details
//
// The gateway refuses an unknown key in every query and body element, so an unknown query key
// or body key is a 400 / 422 here too. Errors are `{ error: <message> }`. The batch routes need
// `Content-Type: application/json` (the gateway answers 415 without).

const env = testEnv;
const BASE = env.orderbookUrl;

/** A realistic 77-digit outcome token id (below 2^256). */
export const TOKEN_YES =
  '71321045679252212594626385532706912750332728571942532289631379312455583992563';
export const TOKEN_NO =
  '8802147012273883360221137405012849313470132094571332090263845117562104871329';
/** A token id the gateway does not know. */
export const TOKEN_UNKNOWN = '424242';
export const CONDITION_A = `0x${'a1'.repeat(32)}`;
export const CONDITION_B = `0x${'b2'.repeat(32)}`;

/** `NO_ORDERBOOK_ERROR` and `MARKET_NOT_FOUND_ERROR` of the gateway. */
export const NO_ORDERBOOK_ERROR =
  'No orderbook exists for the requested token id';
export const MARKET_NOT_FOUND_ERROR = 'market not found';
const MAX_MARKETS_PER_PAGE = 500;
const DEFAULT_MARKETS_PER_PAGE = 100;
const CURSOR_END = 'LTE=';
/** The gateway's `/time`, in unix seconds. */
export const SERVER_TIME_SEC = 1_800_000_123;

export interface Level {
  /** A tick, 1..999. */
  tick: number;
  /** The size as the gateway prints it: whole shares, trailing zeros trimmed. */
  size: string;
}

export interface FixtureBook {
  bids: Level[];
  asks: Level[];
  /** The last trade: a tick and the taker's side. */
  last?: { tick: number; side: 'BUY' | 'SELL' };
  /**
   * `[unix seconds, tick]` pairs, written oldest first. The fake answers them newest first,
   * as the gateway does (it walks the trade log backwards).
   */
  history?: Array<[number, number]>;
}

export interface FixtureCommitment {
  order_id: string;
  status: 'resting' | 'spent_tombstone';
  outcome: 'yes' | 'no';
  side?: 'buy' | 'sell';
  price?: string;
  size?: string;
  remaining?: string;
}

export interface FixtureMarket {
  condition_id: string;
  yes: string;
  no: string;
  active?: boolean;
  variant?: 'clob' | 'clob_pulse' | 'conviction';
  creator?: string | null;
  commitment?: FixtureCommitment | null;
}

/** One request that reached a handler. */
export interface MarketDataRequest {
  method: string;
  path: string;
  /** The query string with its `?`, or `''`. */
  search: string;
  body: string;
  headers: Headers;
}

export interface MarketData {
  /** "METHOD /path" for every request that reached a handler. */
  calls: string[];
  requests: MarketDataRequest[];
  paused: boolean;
  /** The books by token id. A token without an entry is unknown. */
  books: Map<string, FixtureBook>;
  markets: FixtureMarket[];
  /**
   * Answers instead of the normal handling of `route` (the path, such as `/book`), before any
   * check. Returning `undefined` leaves the request to the handler.
   */
  override?: (route: string, request: Request) => Response | undefined;
}

export interface MarketDataOptions {
  markets?: FixtureMarket[];
  books?: Record<string, FixtureBook>;
}

export const gatewayError = (status: number, message: string): Response =>
  HttpResponse.json({ error: message }, { status });

/** A tick as the gateway prints a book price: padded, such as `"0.550"`. */
export function tickToDecimal(tick: number): string {
  return `${Math.floor(tick / 1000)}.${String(tick % 1000).padStart(3, '0')}`;
}

/** A tick as the gateway prints a query price: trailing zeros trimmed, such as `"0.55"`, and `"1"` for 1000. */
export function tickToClobPrice(tick: number): string {
  const whole = Math.floor(tick / 1000);
  const frac = tick % 1000;
  if (frac === 0) {
    return String(whole);
  }
  return `${whole}.${String(frac).padStart(3, '0')}`.replace(/0+$/, '');
}

/** A midpoint as the gateway prints it: a half tick keeps its 4th decimal, such as `"0.5005"`. */
export function formatMidpoint(bid: number, ask: number): string {
  const sum = bid + ask;
  const whole = Math.floor(sum / 2);
  if (sum % 2 === 0) {
    return tickToClobPrice(whole);
  }
  return `${Math.floor(whole / 1000)}.${String(whole % 1000).padStart(3, '0')}5`;
}

/** The default fixture: a two-sided YES book with a trade, and a one-sided NO book. */
export function defaultBooks(): Record<string, FixtureBook> {
  return {
    [TOKEN_YES]: {
      bids: [
        { tick: 550, size: '100' },
        { tick: 540, size: '25.5' },
      ],
      asks: [
        { tick: 560, size: '80.123456' },
        { tick: 570, size: '10' },
      ],
      last: { tick: 555, side: 'BUY' },
      history: [
        [1_800_000_000, 500],
        [1_800_000_060, 520],
        [1_800_000_120, 550],
      ],
    },
    [TOKEN_NO]: { bids: [{ tick: 440, size: '5' }], asks: [] },
  };
}

export function defaultMarkets(): FixtureMarket[] {
  return [
    {
      condition_id: CONDITION_A,
      yes: TOKEN_YES,
      no: TOKEN_NO,
      active: true,
      variant: 'conviction',
      creator: `0x${'c0'.repeat(20)}`,
      commitment: {
        order_id: '77',
        status: 'resting',
        outcome: 'yes',
        side: 'buy',
        price: '0.700',
        size: '50',
        remaining: '50',
      },
    },
    {
      condition_id: CONDITION_B,
      yes: '111',
      no: '222',
      active: false,
      variant: 'clob',
      creator: null,
      commitment: null,
    },
  ];
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

/** A query the gateway checks strictly: unknown, repeated and missing keys are a 400. */
function readQuery(
  request: Request,
  allowed: readonly string[],
  required: readonly string[],
): Parsed<URLSearchParams> {
  const params = new URL(request.url).searchParams;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      return {
        ok: false,
        response: gatewayError(
          400,
          `Failed to deserialize query string: unknown field \`${key}\``,
        ),
      };
    }
    if (seen.has(key)) {
      return {
        ok: false,
        response: gatewayError(
          400,
          `Failed to deserialize query string: duplicate field \`${key}\``,
        ),
      };
    }
    seen.add(key);
  }
  for (const key of required) {
    if (!params.has(key)) {
      return {
        ok: false,
        response: gatewayError(
          400,
          `Failed to deserialize query string: missing field \`${key}\``,
        ),
      };
    }
  }
  return { ok: true, value: params };
}

/** A token id as the gateway checks it: a decimal uint256 of a valid length. */
function checkTokenId(value: string): Response | undefined {
  if (value.length > 256) {
    return gatewayError(400, 'token_id exceeds maximum length of 256 bytes');
  }
  if (!/^[0-9]+$/.test(value) || BigInt(value) >= 1n << 256n) {
    return gatewayError(400, 'invalid token_id: invalid digit found in string');
  }
  return undefined;
}

type SideKey = 'BUY' | 'SELL';

function readSide(text: string): SideKey | undefined {
  const side = text.toUpperCase();
  if (side === 'BUY' || side === 'BID') {
    return 'BUY';
  }
  if (side === 'SELL' || side === 'ASK') {
    return 'SELL';
  }
  return undefined;
}

interface BodyItem {
  token_id: string;
  side?: string;
}

/**
 * The body of a batch route: a JSON array of objects that
 * have exactly `token_id` (and `side`). 415 without a JSON content type, 400 for bad JSON,
 * 422 for a wrong shape or an unknown field.
 */
function readBody(
  request: Request,
  text: string,
  withSide: boolean,
): Parsed<BodyItem[]> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      response: gatewayError(
        415,
        'Expected request with `Content-Type: application/json`',
      ),
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: gatewayError(400, 'Failed to parse the request body as JSON'),
    };
  }
  const bad = (message: string): Parsed<BodyItem[]> => ({
    ok: false,
    response: gatewayError(422, message),
  });
  if (!Array.isArray(value)) {
    return bad('expected a list');
  }
  const allowed = withSide ? ['token_id', 'side'] : ['token_id'];
  const items: BodyItem[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return bad('expected an object');
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) {
        return bad(`unknown field \`${key}\``);
      }
    }
    if (typeof record.token_id !== 'string') {
      return bad('missing field `token_id`');
    }
    if (withSide && typeof record.side !== 'string') {
      return bad('missing field `side`');
    }
    items.push(record as unknown as BodyItem);
  }
  return { ok: true, value: items };
}

function bestBid(book: FixtureBook): number | undefined {
  return book.bids.length === 0
    ? undefined
    : Math.max(...book.bids.map((l) => l.tick));
}

function bestAsk(book: FixtureBook): number | undefined {
  return book.asks.length === 0
    ? undefined
    : Math.min(...book.asks.map((l) => l.tick));
}

/** The best price on a side, or `"0.000"` for an empty side. */
function priceOf(book: FixtureBook, side: SideKey): string {
  const tick = side === 'BUY' ? bestBid(book) : bestAsk(book);
  return tick === undefined ? '0.000' : tickToClobPrice(tick);
}

function midpointOf(book: FixtureBook): string {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  return bid === undefined || ask === undefined
    ? '0.000'
    : formatMidpoint(bid, ask);
}

/** The spread, `"0"` when a side is empty. */
function spreadOf(book: FixtureBook): string | undefined {
  const bid = bestBid(book);
  const ask = bestAsk(book);
  return bid === undefined || ask === undefined
    ? undefined
    : tickToClobPrice(Math.max(ask - bid, 0));
}

function bookResponse(tokenId: string, book: FixtureBook) {
  const level = (l: Level) => ({ price: tickToDecimal(l.tick), size: l.size });
  return {
    market: CONDITION_A,
    asset_id: tokenId,
    timestamp: '1800000123456',
    hash: 'ab12cd34',
    bids: [...book.bids].sort((a, b) => b.tick - a.tick).map(level),
    asks: [...book.asks].sort((a, b) => a.tick - b.tick).map(level),
    min_order_size: '0',
    tick_size: '0.001',
    neg_risk: false,
    last_trade_price: '0.000',
    last_update_id: 42,
  };
}

function marketToken(tokenId: string, outcome: 'Yes' | 'No', data: MarketData) {
  const book = data.books.get(tokenId);
  let price = '0.000';
  if (book !== undefined) {
    const bid = bestBid(book);
    const ask = bestAsk(book);
    if (bid !== undefined && ask !== undefined) {
      price = formatMidpoint(bid, ask);
    } else if (book.last !== undefined) {
      price = tickToClobPrice(book.last.tick);
    }
  }
  return { token_id: tokenId, outcome, price };
}

function marketObject(market: FixtureMarket, data: MarketData) {
  return {
    condition_id: market.condition_id,
    tokens: [
      marketToken(market.yes, 'Yes', data),
      marketToken(market.no, 'No', data),
    ],
    minimum_tick_size: 0.001,
    neg_risk: false,
    active: market.active ?? true,
  };
}

function convictionMarketObject(market: FixtureMarket, data: MarketData) {
  return {
    condition_id: market.condition_id,
    tokens: [
      marketToken(market.yes, 'Yes', data),
      marketToken(market.no, 'No', data),
    ],
    active: market.active ?? true,
    variant: market.variant ?? 'clob',
    creator: market.creator ?? null,
    commitment: market.commitment ?? null,
  };
}

/** A cursor as the gateway reads it: the end sentinels and anything undecodable are offset 0. */
function decodeCursor(cursor: string | null): number {
  if (cursor === null || cursor === '' || cursor === CURSOR_END) {
    return 0;
  }
  if (cursor === 'END') {
    return 0;
  }
  const offset = Number(Buffer.from(cursor, 'base64').toString('utf8'));
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
}

/**
 * Installs the handlers on `server` and returns the live state of the fake gateway. Call it
 * in a test, after `server.listen()`; `server.resetHandlers()` removes the handlers.
 */
export function installMarketData(
  server: SetupServer,
  options: MarketDataOptions = {},
): MarketData {
  const data: MarketData = {
    calls: [],
    requests: [],
    paused: false,
    books: new Map(Object.entries(options.books ?? defaultBooks())),
    markets: options.markets ?? defaultMarkets(),
  };

  async function record(request: Request, path: string): Promise<string> {
    const url = new URL(request.url);
    const body = await request.text();
    data.calls.push(`${request.method} ${path}`);
    data.requests.push({
      method: request.method,
      path,
      search: url.search,
      body,
      headers: request.headers,
    });
    return body;
  }

  /** Records the request, then runs `handle` unless the test overrides the route. */
  function route(
    path: string,
    handle: (request: Request, body: string) => Response | Promise<Response>,
  ) {
    return async ({ request }: { request: Request }): Promise<Response> => {
      const body = await record(request, path);
      return data.override?.(path, request) ?? handle(request, body);
    };
  }

  /** A single-token GET: the query is `token_id` plus `extra`. */
  function tokenRead(
    path: string,
    extra: readonly string[],
    required: readonly string[],
    answer: (
      tokenId: string,
      params: URLSearchParams,
      book: FixtureBook | undefined,
    ) => Response,
  ) {
    return route(path, (request) => {
      const query = readQuery(
        request,
        ['token_id', ...extra],
        ['token_id', ...required],
      );
      if (!query.ok) {
        return query.response;
      }
      const tokenId = query.value.get('token_id') ?? '';
      const invalid = checkTokenId(tokenId);
      if (invalid !== undefined) {
        return invalid;
      }
      return answer(tokenId, query.value, data.books.get(tokenId));
    });
  }

  const noOrderbook = () => gatewayError(404, NO_ORDERBOOK_ERROR);

  /** A batch POST: the body is `[{token_id}]` (or `[{token_id, side}]`). */
  function batch(
    path: string,
    withSide: boolean,
    answer: (items: BodyItem[]) => Response,
  ) {
    return route(path, (request, text) => {
      const parsed = readBody(request, text, withSide);
      if (!parsed.ok) {
        return parsed.response;
      }
      for (const item of parsed.value) {
        const invalid = checkTokenId(item.token_id);
        if (invalid !== undefined) {
          return invalid;
        }
      }
      return answer(parsed.value);
    });
  }

  const marketsPage = (
    request: Request,
    render: (market: FixtureMarket) => unknown,
  ): Response => {
    const query = readQuery(request, ['next_cursor', 'limit'], []);
    if (!query.ok) {
      return query.response;
    }
    let limit = DEFAULT_MARKETS_PER_PAGE;
    const limitText = query.value.get('limit');
    if (limitText !== null) {
      if (!/^\d+$/.test(limitText)) {
        return gatewayError(
          400,
          'Failed to deserialize query string: invalid digit found in string',
        );
      }
      limit = Number(limitText);
      if (limit < 1 || limit > MAX_MARKETS_PER_PAGE) {
        return gatewayError(
          400,
          `limit must be between 1 and ${MAX_MARKETS_PER_PAGE}`,
        );
      }
    }
    const total = data.markets.length;
    const offset = Math.min(
      decodeCursor(query.value.get('next_cursor')),
      total,
    );
    const next = offset + limit;
    return HttpResponse.json({
      limit,
      count: total,
      next_cursor:
        next < total
          ? Buffer.from(String(next)).toString('base64')
          : CURSOR_END,
      data: data.markets.slice(offset, next).map(render),
    });
  };

  const marketById = (
    id: string,
    render: (market: FixtureMarket) => unknown,
  ): Response => {
    const market = data.markets.find((m) => m.condition_id === id);
    return market === undefined
      ? gatewayError(404, `market not found: ${id}`)
      : HttpResponse.json(render(market) as Record<string, unknown>);
  };

  server.use(
    http.get(
      `${BASE}/time`,
      route('/time', () => HttpResponse.json(SERVER_TIME_SEC)),
    ),

    http.get(
      `${BASE}/tick-size`,
      tokenRead('/tick-size', [], [], (_token, _params, book) =>
        book === undefined
          ? gatewayError(404, MARKET_NOT_FOUND_ERROR)
          : HttpResponse.json({ minimum_tick_size: 0.001 }),
      ),
    ),

    http.get(
      `${BASE}/trading-state`,
      route('/trading-state', () =>
        HttpResponse.json(
          { state: data.paused ? 'paused' : 'active' },
          { headers: { 'cache-control': 'no-store' } },
        ),
      ),
    ),

    http.get(
      `${BASE}/book`,
      tokenRead('/book', [], [], (token, _params, book) =>
        book === undefined
          ? noOrderbook()
          : HttpResponse.json(bookResponse(token, book)),
      ),
    ),

    http.post(
      `${BASE}/books`,
      batch('/books', false, (items) => {
        const out = [];
        for (const item of items) {
          const book = data.books.get(item.token_id);
          if (book === undefined) {
            // The engine's market-not-found error is a 404 with this text.
            return gatewayError(404, 'market not found: unknown');
          }
          out.push(bookResponse(item.token_id, book));
        }
        return HttpResponse.json(out);
      }),
    ),

    http.get(
      `${BASE}/midpoint`,
      tokenRead('/midpoint', [], [], (_token, _params, book) =>
        book === undefined
          ? noOrderbook()
          : HttpResponse.json({ mid: midpointOf(book) }),
      ),
    ),

    http.post(
      `${BASE}/midpoints`,
      batch('/midpoints', false, (items) => {
        const out: Record<string, string> = {};
        for (const item of items) {
          const book = data.books.get(item.token_id);
          if (book !== undefined) {
            out[item.token_id] = midpointOf(book);
          }
        }
        return HttpResponse.json(out);
      }),
    ),

    http.get(
      `${BASE}/price`,
      tokenRead('/price', ['side'], ['side'], (_token, params, book) => {
        const side = readSide(params.get('side') ?? '');
        if (side === undefined) {
          return gatewayError(400, 'side must be BUY or SELL');
        }
        return book === undefined
          ? noOrderbook()
          : HttpResponse.json({ price: priceOf(book, side) });
      }),
    ),

    http.post(
      `${BASE}/prices`,
      batch('/prices', true, (items) => {
        const out: Record<string, Record<string, string>> = {};
        for (const item of items) {
          const side = readSide(item.side ?? '');
          if (side === undefined) {
            return gatewayError(400, 'side must be BUY or SELL');
          }
          const book = data.books.get(item.token_id);
          if (book !== undefined) {
            out[item.token_id] = {
              ...out[item.token_id],
              [side]: priceOf(book, side),
            };
          }
        }
        return HttpResponse.json(out);
      }),
    ),

    http.get(
      `${BASE}/spread`,
      tokenRead('/spread', [], [], (_token, _params, book) =>
        book === undefined
          ? noOrderbook()
          : HttpResponse.json({ spread: spreadOf(book) ?? '0' }),
      ),
    ),

    http.post(
      `${BASE}/spreads`,
      batch('/spreads', false, (items) => {
        const out: Record<string, string> = {};
        for (const item of items) {
          const book = data.books.get(item.token_id);
          const spread = book === undefined ? undefined : spreadOf(book);
          if (spread !== undefined) {
            out[item.token_id] = spread;
          }
        }
        return HttpResponse.json(out);
      }),
    ),

    http.get(
      `${BASE}/last-trade-price`,
      tokenRead('/last-trade-price', [], [], (_token, _params, book) =>
        book?.last === undefined
          ? HttpResponse.json({ price: '0.5', side: '' })
          : HttpResponse.json({
              price: tickToClobPrice(book.last.tick),
              side: book.last.side,
            }),
      ),
    ),

    http.post(
      `${BASE}/last-trades-prices`,
      batch('/last-trades-prices', false, (items) => {
        const out = [];
        for (const item of items) {
          const last = data.books.get(item.token_id)?.last;
          if (last !== undefined) {
            out.push({
              price: tickToClobPrice(last.tick),
              side: last.side,
              token_id: item.token_id,
            });
          }
        }
        return HttpResponse.json(out);
      }),
    ),

    http.get(
      `${BASE}/prices-history`,
      tokenRead(
        '/prices-history',
        ['interval', 'fidelity'],
        [],
        (_token, params, book) => {
          const fidelity = params.get('fidelity');
          if (fidelity !== null && !/^\d+$/.test(fidelity)) {
            return gatewayError(
              400,
              'Failed to deserialize query string: invalid digit found in string',
            );
          }
          const limit = Math.min(
            fidelity === null ? 100 : Number(fidelity),
            500,
          );
          // The newest `limit` points, newest first.
          const points = (book?.history ?? []).slice(-limit).reverse();
          return HttpResponse.json({
            history: points.map(([t, tick]) => ({
              t,
              p: tickToDecimal(tick),
            })),
          });
        },
      ),
    ),

    http.get(
      `${BASE}/markets`,
      route('/markets', (request) =>
        marketsPage(request, (m) => marketObject(m, data)),
      ),
    ),

    http.get(`${BASE}/markets/:conditionId`, async ({ request, params }) => {
      const id = String(params.conditionId);
      await record(request, `/markets/${id}`);
      return (
        data.override?.('/markets/{condition_id}', request) ??
        marketById(id, (m) => marketObject(m, data))
      );
    }),

    http.get(
      `${BASE}/conviction/markets/:conditionId`,
      async ({ request, params }) => {
        const id = String(params.conditionId);
        await record(request, `/conviction/markets/${id}`);
        return (
          data.override?.('/conviction/markets/{condition_id}', request) ??
          marketById(id, (m) => convictionMarketObject(m, data))
        );
      },
    ),
  );

  return data;
}
