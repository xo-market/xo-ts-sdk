import { describe, expect, test } from 'vitest';
import { PulseMarketSchema } from '../../src/data/catalogSchemas';
import { PulseStatsSchema } from '../../src/data/schemas';
import { toPulseMarket, toPulseStats } from '../../src/models/pulse';
import { conditionIdOf } from '../helpers/mockBackendData';
import { wireStyleKeys } from '../helpers/modelKeys';

const TS = '2026-10-01T12:00:00.000Z';

function pulse(patch: Record<string, unknown> = {}) {
  return PulseMarketSchema.lenient.parse({
    id: 4,
    marketConfigId: 3,
    adapterConfigId: 4,
    marketConfigName: 'BTC 5 min',
    marketAddress: null,
    conditionId: conditionIdOf(4),
    status: 'active',
    cycleNumber: 12,
    startsAt: TS,
    expiresAt: '2026-10-01T12:05:00.000Z',
    observationStartsAt: TS,
    observationEndsAt: '2026-10-01T12:04:00.000Z',
    resolvedAt: null,
    closedAt: null,
    openingTwap: null,
    closingTwap: null,
    openingPrice: '81918.80912067',
    closingPrice: null,
    winningOutcome: null,
    sampleCount: 17,
    resolutionData: null,
    marketMetadata: { symbol: 'BTC' },
    createdAt: TS,
    updatedAt: TS,
    ...patch,
  });
}

describe('toPulseMarket', () => {
  test('maps a CLOB pulse round: the id is text and the dates are named like a market state', () => {
    expect(toPulseMarket(pulse())).toEqual({
      id: '4',
      conditionId: conditionIdOf(4),
      name: 'BTC 5 min',
      status: 'active',
      cycle: 12,
      startDate: TS,
      endDate: '2026-10-01T12:05:00.000Z',
      observationStartDate: TS,
      observationEndDate: '2026-10-01T12:04:00.000Z',
      resolvedAt: null,
      closedAt: null,
      openingPrice: '81918.80912067',
      closingPrice: null,
      winningOutcome: null,
      sampleCount: 17,
      metadata: { symbol: 'BTC' },
    });
  });

  test('a round of the older pricing-curve kind (no condition id) is left out', () => {
    expect(
      toPulseMarket(
        pulse({
          conditionId: null,
          marketAddress: `0x${'ab'.repeat(20)}`,
          openingTwap: '64250.5',
          openingPrice: null,
        }),
      ),
    ).toBeUndefined();
  });

  test('the condition id is lower case', () => {
    const upper = `0x${'AB'.repeat(32)}`;
    expect(toPulseMarket(pulse({ conditionId: upper }))?.conditionId).toBe(
      upper.toLowerCase(),
    );
  });

  test('the winner is yes for the first outcome and no for the second; anything else is no winner', () => {
    const winner = (winningOutcome: number | null) =>
      toPulseMarket(pulse({ winningOutcome }))?.winningOutcome;
    expect(winner(0)).toBe('yes');
    expect(winner(1)).toBe('no');
    expect(winner(null)).toBeNull();
    expect(winner(2)).toBeNull();
  });

  test('a missing metadata is an empty object, and a resolved round keeps its times', () => {
    const model = toPulseMarket(
      pulse({
        marketMetadata: null,
        status: 'resolved',
        resolvedAt: '2026-10-01T12:06:00.000Z',
        closedAt: '2026-10-01T12:07:00.000Z',
        closingPrice: '81950.5',
        winningOutcome: 0,
      }),
    );
    expect(model).toMatchObject({
      status: 'resolved',
      resolvedAt: '2026-10-01T12:06:00.000Z',
      closedAt: '2026-10-01T12:07:00.000Z',
      closingPrice: '81950.5',
      metadata: {},
    });
  });

  test('no snake_case or ID-suffixed key, and nothing of the answer that the model does not name', () => {
    const model = toPulseMarket(pulse({ wire_extra: 1, wireExtra: 2 }));
    expect(wireStyleKeys(model)).toEqual([]);
    expect(Object.keys(model ?? {})).not.toContain('wireExtra');
    expect(Object.keys(model ?? {})).not.toContain('marketConfigId');
    expect(Object.keys(model ?? {})).not.toContain('marketAddress');
  });

  test('the metadata is a copy', () => {
    const raw = pulse();
    const model = toPulseMarket(raw);
    expect(model?.metadata).not.toBe(raw.marketMetadata);
  });
});

describe('toPulseStats', () => {
  test('maps the totals to counts and amounts', () => {
    const raw = PulseStatsSchema.lenient.parse({
      totalVolume: '1234567.89',
      totalTrades: 847,
      uniqueTraders: 12481,
      totalMarkets: 42,
      currentPositionsValue: '234567.89',
      initialCollateral: '50000.00',
    });
    expect(toPulseStats(raw)).toEqual({
      volume: '1234567.89',
      tradeCount: 847,
      traderCount: 12481,
      marketCount: 42,
      positionsValue: '234567.89',
      initialCollateral: '50000.00',
    });
  });
});
