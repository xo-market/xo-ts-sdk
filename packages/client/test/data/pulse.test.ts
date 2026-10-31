import { HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { UserInputError } from '../../src/core/errors';
import { caught, dataRig, expectNoRequest, last } from '../helpers/dataRig';
import {
  conditionIdOf,
  PULSE_ADDRESS,
  PULSE_ADDRESS_2,
  PULSE_COUNT,
} from '../helpers/mockBackendData';
import { rejectedWith } from '../helpers/rejections';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  vi.restoreAllMocks();
});
afterAll(() => server.close());

describe('pulse.list', () => {
  test('GET /api/pulse/markets with no credentials', async () => {
    const { client, backend } = dataRig(server, { session: true });
    const page = await client.pulse.list().firstPage();
    expect(last(backend).path).toBe('/api/pulse/markets');
    expect(last(backend).query).toEqual({ page: '1' });
    expect(last(backend).authorization).toBeNull();
    expect(page.items).toHaveLength(PULSE_COUNT);
    expect(page.items[0]).toMatchObject({
      id: 1,
      marketConfigName: 'BTC 1h',
      status: 'active',
      cycleNumber: 12,
      // A price: a decimal string, whichever way the service sent it.
      openingTwap: '64250.5',
      closingTwap: null,
      sampleCount: 17,
    });
  });

  test('pulse.list paginates page/limit shape', async () => {
    const { client, backend } = dataRig(server);
    const pages: Array<{ raw: unknown; hasNext: boolean }> = [];
    for await (const page of client.pulse.list({ limit: 2 }).pages()) {
      pages.push(page);
      if (pages.length >= 20) break; // a runaway traversal fails the assertions below
    }
    expect(pages.map((page) => page.hasNext)).toEqual([true, true, false]);
    expect(backend.requests.map((request) => request.query)).toEqual([
      { page: '1', limit: '2' },
      { page: '2', limit: '2' },
      { page: '3', limit: '2' },
    ]);
    // The raw page keeps the service's own meta (limit, total, totalPages).
    expect(pages[0]?.raw).toMatchObject({
      meta: {
        page: 1,
        limit: 2,
        total: PULSE_COUNT,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: false,
      },
    });
    expect(await client.pulse.list({ limit: 2 }).toArray(200)).toHaveLength(
      PULSE_COUNT,
    );
  });

  test('sends every supported filter in one request', async () => {
    const { client, backend } = dataRig(server);
    await client.pulse
      .list({
        page: 1,
        limit: 100,
        status: 'ACTIVE',
        marketConfigId: 3,
        adapterConfigId: 4,
        sortBy: 'expiresAt',
        sortOrder: 'ASC',
      })
      .firstPage();
    expect(last(backend).query).toEqual({
      page: '1',
      limit: '100',
      status: 'ACTIVE',
      marketConfigId: '3',
      adapterConfigId: '4',
      sortBy: 'expiresAt',
      sortOrder: 'ASC',
    });
  });

  test('unknown keys and out-of-range limits are ValidationErrors before any request', () => {
    const { client, backend } = dataRig(server);
    expect(() => client.pulse.list({ take: 5 } as never)).toThrow(
      UserInputError,
    );
    expect(() => client.pulse.list({ limit: 101 })).toThrow(UserInputError);
    expect(() => client.pulse.list({ limit: 0 })).toThrow(UserInputError);
    expect(() => client.pulse.list({ sortBy: 'startsAt' } as never)).toThrow(
      UserInputError,
    );
    expectNoRequest(backend);
  });
});

describe('pulse.batch / get', () => {
  test('batch(addresses) is GET /api/pulse/markets/batch?addresses=a,b: a bare array, one page', async () => {
    const { client, backend } = dataRig(server);
    const page = await client.pulse
      .batch([PULSE_ADDRESS, PULSE_ADDRESS_2])
      .firstPage();
    expect(last(backend).path).toBe('/api/pulse/markets/batch');
    expect(last(backend).query).toEqual({
      addresses: `${PULSE_ADDRESS},${PULSE_ADDRESS_2}`,
    });
    expect(page.hasNext).toBe(false);
    // The raw answer repeats a market the service keyed twice (by address and condition id)...
    expect((page.raw as unknown[]).length).toBe(3);
    // ...and the items list each market once.
    expect(page.items.map((market) => market.id)).toEqual([1, 2]);
  });

  test('batch([]) asks nothing and answers an empty page', async () => {
    const { client, backend } = dataRig(server);
    const page = await client.pulse.batch([]).firstPage();
    expect(page.items).toEqual([]);
    expect(page.hasNext).toBe(false);
    expectNoRequest(backend);
  });

  test('batch refuses a bad list before any request', () => {
    const { client, backend } = dataRig(server);
    expect(() => client.pulse.batch('0xabc' as never)).toThrow(UserInputError);
    expect(() => client.pulse.batch(['not-an-address'])).toThrow(
      UserInputError,
    );
    // 100 is the SDK's own guard (the backend has no limit), and the message says so.
    expect(() => client.pulse.batch(Array(101).fill(PULSE_ADDRESS))).toThrow(
      /an SDK limit/,
    );
    expect(() =>
      client.pulse.batch(Array(100).fill(PULSE_ADDRESS)),
    ).not.toThrow();
    expectNoRequest(backend);
  });

  test('get(address) is GET /api/pulse/markets/:address; 404 → 404 rejection', async () => {
    const { client, backend } = dataRig(server);
    const market = await client.pulse.get(PULSE_ADDRESS);
    expect(last(backend).path).toBe(`/api/pulse/markets/${PULSE_ADDRESS}`);
    expect(market).toMatchObject({ id: 1, marketAddress: PULSE_ADDRESS });
    expect(
      await caught(() => client.pulse.get(`0x${'ef'.repeat(20)}`)),
    ).toSatisfy(rejectedWith(404));
    expect(await caught(() => client.pulse.get('batch'))).toBeInstanceOf(
      UserInputError,
    );
    expect(await caught(() => client.pulse.get('0x12'))).toBeInstanceOf(
      UserInputError,
    );
  });
});

describe('what the backend has been seen to send (live check)', () => {
  test('a CLOB pulse market has a null marketAddress, a condition id and opening and closing prices', async () => {
    const { client } = dataRig(server, { strict: true });
    const rows = await client.pulse.list({ limit: 5 }).toArray(5);
    const clob = rows.find((row) => row.id === 3);
    expect(clob).toMatchObject({
      marketAddress: null,
      conditionId: conditionIdOf(3),
      marketConfigName: 'BTC 5 min',
      openingTwap: null,
      openingPrice: '81918.80912067',
      closingPrice: null,
    });
    // An AMM pulse market is the other way round.
    expect(rows[0]).toMatchObject({
      marketAddress: PULSE_ADDRESS,
      conditionId: null,
      openingTwap: '64250.5',
      openingPrice: null,
    });
  });

  test('get and batch take a condition id as well as an address', async () => {
    const { client, backend } = dataRig(server, { strict: true });
    const one = await client.pulse.get(conditionIdOf(4));
    expect(one.id).toBe(4);
    expect(last(backend).path).toBe(`/api/pulse/markets/${conditionIdOf(4)}`);
    const batch = await client.pulse
      .batch([conditionIdOf(3), conditionIdOf(5)])
      .toArray(10);
    expect(batch.map((row) => row.id)).toEqual([3, 5]);
  });

  test('lenient mode keeps a field the schema does not know yet', async () => {
    const { client, backend } = dataRig(server);
    backend.override = (request) =>
      request.path === `/api/pulse/markets/${PULSE_ADDRESS}`
        ? HttpResponse.json({
            ...(pulseRow() as object),
            someFutureField: 'x',
          })
        : undefined;
    const market = await client.pulse.get(PULSE_ADDRESS);
    expect((market as unknown as Record<string, unknown>).someFutureField).toBe(
      'x',
    );
  });
});

/** A valid pulse row, from the fake itself. */
function pulseRow(): unknown {
  return {
    id: 1,
    marketConfigId: 3,
    adapterConfigId: 4,
    marketConfigName: 'BTC 1h',
    marketAddress: PULSE_ADDRESS,
    conditionId: null,
    status: 'active',
    cycleNumber: 12,
    startsAt: '2026-10-01T12:00:00.000Z',
    expiresAt: '2026-10-01T13:00:00.000Z',
    observationStartsAt: '2026-10-01T12:00:00.000Z',
    observationEndsAt: '2026-10-01T12:55:00.000Z',
    sampleCount: 17,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  };
}
