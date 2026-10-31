import { describe, expect, test } from 'vitest';
import { OrderSide, OrderType } from '../../src/models/enums';

describe('enums', () => {
  test('OrderSide has the two sides, as the strings the venue uses', () => {
    expect(OrderSide.BUY).toBe('BUY');
    expect(OrderSide.SELL).toBe('SELL');
    expect(Object.values(OrderSide).sort()).toEqual(['BUY', 'SELL']);
  });

  test('OrderType has the four times in force, as the strings the venue uses', () => {
    expect(OrderType.GTC).toBe('GTC');
    expect(OrderType.GTD).toBe('GTD');
    expect(OrderType.FOK).toBe('FOK');
    expect(OrderType.FAK).toBe('FAK');
    expect(Object.values(OrderType).sort()).toEqual([
      'FAK',
      'FOK',
      'GTC',
      'GTD',
    ]);
  });

  test('a string enum member is not assignable from a plain string', () => {
    // @ts-expect-error a plain string is not an OrderSide
    const side: OrderSide = 'BUY';
    expect(side).toBe(OrderSide.BUY);
  });
});
