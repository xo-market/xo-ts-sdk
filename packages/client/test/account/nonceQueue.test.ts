import type { Address } from 'viem';
import { describe, expect, test } from 'vitest';
import { serializeByExecutor } from '../../src/account/nonceQueue';

// The send queue of each executor, and its case-insensitive key.

const A: Address = `0x${'a1'.repeat(20)}`;
const B: Address = `0x${'b2'.repeat(20)}`;

const delayed = (bucket: unknown[], id: unknown, ms: number) => () =>
  new Promise<void>((resolve) =>
    setTimeout(() => {
      bucket.push(id);
      resolve();
    }, ms),
  );

describe('serializeByExecutor', () => {
  test('runs same-executor tasks sequentially even when a later one is faster', async () => {
    const order: number[] = [];
    const p1 = serializeByExecutor(A, delayed(order, 1, 30));
    const p2 = serializeByExecutor(A, delayed(order, 2, 1));
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test('lets a rejection through without breaking the chain', async () => {
    await expect(
      serializeByExecutor(B, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(serializeByExecutor(B, async () => 'ok')).resolves.toBe('ok');
  });

  test('does not serialize across different executors', async () => {
    const order: string[] = [];
    const slowA = serializeByExecutor(A, delayed(order, 'A', 25));
    const fastB = serializeByExecutor(B, async () => {
      order.push('B');
    });
    await Promise.all([slowA, fastB]);
    expect(order[0]).toBe('B');
  });

  test('keys the queue case-insensitively', async () => {
    const order: number[] = [];
    const upper = A.toUpperCase().replace('0X', '0x') as Address;
    const p1 = serializeByExecutor(A, delayed(order, 1, 30));
    const p2 = serializeByExecutor(upper, delayed(order, 2, 1));
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  test('a task that throws synchronously still releases the queue', async () => {
    await expect(
      serializeByExecutor(A, () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    await expect(serializeByExecutor(A, async () => 7)).resolves.toBe(7);
  });
});
