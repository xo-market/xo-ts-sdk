import {
  type Address,
  type Hex,
  hashTypedData,
  recoverTypedDataAddress,
  zeroAddress,
} from 'viem';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { UserInputError } from '../../src/core/errors';
import type { Side } from '../../src/core/types';
import { deriveAmounts, gatewayTick } from '../../src/orderbook/amounts';
import {
  type BuilderContext,
  buildLimitOrder,
  buildMarketOrder,
  type LimitOrderArgs,
  type MarketOrderArgs,
} from '../../src/orderbook/builder';
import { kernelWrapTypedData } from '../../src/signing/kernel';
import {
  hashOrder,
  orderDomain,
  orderTypedData,
} from '../../src/signing/order';
import {
  resolveTradingIdentity,
  type TradingIdentity,
} from '../../src/wallet/identity';
import { keySigner } from '../helpers/signers';
import { testEnv } from '../helpers/testEnv';
import {
  clobAuthVector,
  expectInvalidAsync,
  kernelVector,
} from '../signing/helpers';

const env = testEnv;
const signer = keySigner(clobAuthVector.inputs.privateKey);
const OWNER = signer.address;
const ACCOUNT = kernelVector.createAccount.expectedAccount;
const DOMAIN = orderDomain(env.chainId, env.contracts.ctfExchange);

/** The mocked server clock, in unix seconds. */
const NOW = 1_800_000_000;
const NONCE = 7n;
/** A realistic 77-digit outcome token id (below 2^256). */
const TOKEN =
  '71321045679252212594626385532706912750332728571942532289631379312455583992563';
const UINT256_MAX = 2n ** 256n - 1n;
const ZERO_IDENTIFIER = `0x${'00'.repeat(16)}` as Hex;
const ZERO_METADATA = `0x${'00'.repeat(32)}` as Hex;

const eoaIdentity: TradingIdentity = await resolveTradingIdentity(
  signer,
  { type: 'eoa' },
  env,
  async () => '0x',
);
// The factory answers with the account as a left-padded 32-byte word.
const smartWalletIdentity: TradingIdentity = await resolveTradingIdentity(
  signer,
  { type: 'smart_wallet' },
  env,
  async () => `0x${'00'.repeat(12)}${ACCOUNT.slice(2)}` as Hex,
);

/** A context made of spies, so tests can count the calls. */
function makeCtx(over: Partial<BuilderContext> = {}) {
  const nonce = vi.fn(async () => NONCE);
  const tickSize = vi.fn(async (_tokenId: string) => '0.001');
  const nowSec = vi.fn(() => NOW);
  const signTypedData = vi.fn(signer.signTypedData);
  const ctx: BuilderContext = {
    env,
    identity: eoaIdentity,
    signer: { ...signer, signTypedData },
    nonce,
    tickSize,
    nowSec,
    ...over,
  };
  return { ctx, nonce, tickSize, nowSec, signTypedData };
}

const limit = (over: Partial<LimitOrderArgs> = {}): LimitOrderArgs => ({
  tokenId: TOKEN,
  side: 'BUY',
  price: '0.57',
  size: '10',
  ...over,
});

const market = (over: Partial<MarketOrderArgs> = {}): MarketOrderArgs => ({
  tokenId: TOKEN,
  side: 'BUY',
  amount: '4.1',
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildLimitOrder: fields', () => {
  test('maker === signer === identity.address, signatureType from the identity, beneficiary 0x0, zero identifier and metadata', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildLimitOrder(limit(), ctx);
    expect(order.maker).toBe(OWNER);
    expect(order.signer).toBe(OWNER);
    expect(order.maker).toBe(ctx.identity.address);
    expect(order.signatureType).toBe(ctx.identity.signatureType);
    expect(order.signatureType).toBe(0);
    expect(order.beneficiary).toBe(zeroAddress);
    expect(order.identifier).toBe(ZERO_IDENTIFIER);
    expect(order.metadata).toBe(ZERO_METADATA);
    expect(order.expiration).toBe(0n);
    expect(order.tokenId).toBe(BigInt(TOKEN));
  });

  test('smart wallet: maker = signer = the smart wallet, signatureType 3, 0x00-prefixed signature', async () => {
    expect(smartWalletIdentity.type).toBe('smart_wallet');
    expect(smartWalletIdentity.owner).toBe(OWNER);
    const { ctx } = makeCtx({ identity: smartWalletIdentity });
    const { order, wire } = await buildLimitOrder(limit(), ctx);
    expect(order.maker).toBe(ACCOUNT);
    expect(order.signer).toBe(ACCOUNT);
    expect(order.signatureType).toBe(3);
    expect(wire.signatureType).toBe(3);
    expect(wire.maker).toBe(ACCOUNT);
    expect(wire.signature.startsWith('0x00')).toBe(true);
    // 0x00 mode byte + 65-byte owner signature.
    expect(wire.signature).toHaveLength(2 + 66 * 2);
  });

  test('smart wallet: the owner signed the Kernel wrap of the order digest', async () => {
    const { ctx } = makeCtx({ identity: smartWalletIdentity });
    const { order, orderHash, wire } = await buildLimitOrder(limit(), ctx);
    const wrapped = kernelWrapTypedData(orderHash, ACCOUNT, env.chainId);
    const inner = `0x${wire.signature.slice(4)}` as Hex;
    expect(
      await recoverTypedDataAddress({ ...wrapped, signature: inner }),
    ).toBe(OWNER);
    expect(hashTypedData(orderTypedData(order, DOMAIN))).toBe(orderHash);
  });

  test('orderHash === hashOrder(order, orderDomain(chainId, ctfExchange))', async () => {
    const { ctx } = makeCtx();
    const { order, orderHash } = await buildLimitOrder(limit(), ctx);
    expect(orderHash).toBe(
      hashOrder(order, orderDomain(env.chainId, env.contracts.ctfExchange)),
    );
  });

  test('EOA: the signature recovers to the owner over orderTypedData', async () => {
    const { ctx } = makeCtx();
    const { order, wire } = await buildLimitOrder(limit(), ctx);
    expect(wire.signature).toHaveLength(2 + 65 * 2);
    expect(
      await recoverTypedDataAddress({
        ...orderTypedData(order, DOMAIN),
        signature: wire.signature,
      }),
    ).toBe(OWNER);
  });

  test('side is 0 for BUY and 1 for SELL', async () => {
    const { ctx } = makeCtx();
    expect(
      (await buildLimitOrder(limit({ side: 'BUY' }), ctx)).order.side,
    ).toBe(0);
    expect(
      (await buildLimitOrder(limit({ side: 'SELL' }), ctx)).order.side,
    ).toBe(1);
  });

  test('the nonce comes from ctx.nonce()', async () => {
    const { ctx } = makeCtx({ nonce: async () => 12345n });
    const { order, wire } = await buildLimitOrder(limit(), ctx);
    expect(order.nonce).toBe(12345n);
    expect(wire.nonce).toBe('12345');
  });

  test('nonce and tickSize are each called exactly once per limit build', async () => {
    const { ctx, nonce, tickSize } = makeCtx();
    await buildLimitOrder(limit(), ctx);
    expect(nonce).toHaveBeenCalledTimes(1);
    expect(tickSize).toHaveBeenCalledTimes(1);
    expect(tickSize).toHaveBeenCalledWith(TOKEN);
  });
});

describe('buildLimitOrder: salt, identifier, metadata', () => {
  test('without a salt it is random and 64 bits wide: two builds differ', async () => {
    const { ctx } = makeCtx();
    const a = await buildLimitOrder(limit(), ctx);
    const b = await buildLimitOrder(limit(), ctx);
    expect(a.order.salt).not.toBe(b.order.salt);
    expect(a.orderHash).not.toBe(b.orderHash);
    for (const { order } of [a, b]) {
      expect(order.salt).toBeGreaterThanOrEqual(0n);
      expect(order.salt).toBeLessThan(2n ** 64n);
    }
  });

  test('the salt is 8 bytes of crypto.getRandomValues, big-endian', async () => {
    const original = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    const spy = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(((array: Uint8Array) => {
        if (array.length === 8) {
          array.set([0, 0, 0, 0, 0, 0, 1, 2]);
          return array;
        }
        return original(array);
      }) as typeof globalThis.crypto.getRandomValues);
    const { ctx } = makeCtx();
    const { order } = await buildLimitOrder(limit(), ctx);
    expect(order.salt).toBe(258n);
    expect(spy).toHaveBeenCalledWith(expect.any(Uint8Array));
  });

  test('a given salt is used as is, up to 2^256 - 1', async () => {
    const { ctx } = makeCtx();
    expect((await buildLimitOrder(limit({ salt: 0n }), ctx)).order.salt).toBe(
      0n,
    );
    expect(
      (await buildLimitOrder(limit({ salt: UINT256_MAX }), ctx)).order.salt,
    ).toBe(UINT256_MAX);
  });

  test.each([
    ['a number', 5],
    ['a string', '5'],
    ['negative', -1n],
    ['2^256', 2n ** 256n],
  ])('a salt that is %s is a UserInputError', async (_name, salt) => {
    const { ctx, nonce, tickSize } = makeCtx();
    await expectInvalidAsync(
      () => buildLimitOrder(limit({ salt: salt as bigint }), ctx),
      'salt',
    );
    expect(nonce).not.toHaveBeenCalled();
    expect(tickSize).not.toHaveBeenCalled();
  });

  test('a given identifier and metadata are used as is', async () => {
    const identifier = `0x${'ab'.repeat(16)}` as Hex;
    const metadata = `0x${'cd'.repeat(32)}` as Hex;
    const { ctx } = makeCtx();
    const { order, wire } = await buildLimitOrder(
      limit({ identifier, metadata }),
      ctx,
    );
    expect(order.identifier).toBe(identifier);
    expect(order.metadata).toBe(metadata);
    expect(wire.identifier).toBe(identifier);
    expect(wire.metadata).toBe(metadata);
  });

  test.each([
    ['identifier', 'identifier', '0x1234'],
    ['identifier', 'identifier', `0x${'00'.repeat(32)}`],
    ['metadata', 'metadata', `0x${'00'.repeat(16)}`],
    ['metadata', 'metadata', 'not hex'],
  ])(
    'a bad %s (%s = %s) is a UserInputError before any call',
    async (field, _f, value) => {
      const { ctx, nonce, tickSize } = makeCtx();
      await expectInvalidAsync(
        () => buildLimitOrder(limit({ [field]: value as Hex }), ctx),
        field,
      );
      expect(nonce).not.toHaveBeenCalled();
      expect(tickSize).not.toHaveBeenCalled();
    },
  );
});

describe('buildLimitOrder: wire', () => {
  test('integers are decimal strings, side is BUY, and the signature is passed through', async () => {
    const { ctx } = makeCtx();
    const { wire } = await buildLimitOrder(
      limit({ side: 'BUY', price: '0.57', size: '153.641122', salt: 99n }),
      ctx,
    );
    expect(wire).toEqual({
      salt: '99',
      maker: OWNER,
      signer: OWNER,
      beneficiary: zeroAddress,
      tokenId: TOKEN,
      makerAmount: '87575440',
      takerAmount: '153641122',
      expiration: '0',
      nonce: NONCE.toString(),
      identifier: ZERO_IDENTIFIER,
      metadata: ZERO_METADATA,
      side: 'BUY',
      signatureType: 0,
      signature: wire.signature,
    });
    expect(typeof wire.makerAmount).toBe('string');
  });

  test('SELL goes out as the word SELL', async () => {
    const { ctx } = makeCtx();
    const { wire } = await buildLimitOrder(limit({ side: 'SELL' }), ctx);
    expect(wire.side).toBe('SELL');
  });
});

describe('buildLimitOrder: price and size are exact', () => {
  test('0.57 and 153.641122 convert exactly (BUY)', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildLimitOrder(
      limit({ side: 'BUY', price: 0.57, size: 153.641122 }),
      ctx,
    );
    const expected = deriveAmounts('BUY', 570n, 153_641_122n);
    expect(order.makerAmount).toBe(expected.makerAmount);
    expect(order.takerAmount).toBe(expected.takerAmount);
    // Pinned, so a bug shared with deriveAmounts cannot hide: ceil(570 * 153_641_122 / 1000).
    expect(order.makerAmount).toBe(87_575_440n);
    expect(order.takerAmount).toBe(153_641_122n);
    expect(gatewayTick('BUY', order.makerAmount, order.takerAmount)).toBe(570n);
  });

  test('0.57 and 153.641122 convert exactly (SELL, a reference vector)', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildLimitOrder(
      limit({ side: 'SELL', price: '0.57', size: '153.641122' }),
      ctx,
    );
    expect(order.makerAmount).toBe(153_641_122n);
    expect(order.takerAmount).toBe(87_575_439n);
    expect({
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
    }).toEqual(deriveAmounts('SELL', 570n, 153_641_122n));
    expect(gatewayTick('SELL', order.makerAmount, order.takerAmount)).toBe(
      570n,
    );
  });

  test.each<['BUY' | 'SELL', string, string]>([
    ['BUY', '0.001', '1'],
    ['BUY', '0.999', '1'],
    ['SELL', '0.001', '1'],
    ['SELL', '0.999', '1'],
    ['BUY', '0.5', '1.000001'],
  ])(
    '%s %s x %s derives the amounts from the tick and round-trips',
    async (side, price, size) => {
      const { ctx } = makeCtx();
      const { order } = await buildLimitOrder(
        limit({ side, price, size }),
        ctx,
      );
      const tick = BigInt(Math.round(Number(price) * 1000));
      const micro = BigInt(Math.round(Number(size) * 1_000_000));
      expect({
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
      }).toEqual(deriveAmounts(side, tick, micro));
      expect(gatewayTick(side, order.makerAmount, order.takerAmount)).toBe(
        tick,
      );
    },
  );

  test.each([
    ['price 0.0005', { price: 0.0005 }, 'price'],
    ['price "0.0005"', { price: '0.0005' }, 'price'],
    ['price 0.5705', { price: '0.5705' }, 'price'],
    ['price 1e-7', { price: 1e-7 }, 'price'],
    ['price 0.1 + 0.2 (float noise)', { price: 0.1 + 0.2 }, 'price'],
    ['price with 7 decimals', { price: '0.5700001' }, 'price'],
    ['price 0', { price: 0 }, 'price'],
    ['price 1', { price: 1 }, 'price'],
    ['price 0.9995', { price: 0.9995 }, 'price'],
    ['price -0.5', { price: -0.5 }, 'price'],
    ['price NaN', { price: Number.NaN }, 'price'],
    ['price " 0.5"', { price: ' 0.5' }, 'price'],
    ['price ""', { price: '' }, 'price'],
    ['size 1.0000001', { size: 1.0000001 }, 'size'],
    ['size "1.0000001"', { size: '1.0000001' }, 'size'],
    ['size 1e-7', { size: 1e-7 }, 'size'],
    ['size 0.1 + 0.2 (float noise)', { size: 0.1 + 0.2 }, 'size'],
    ['size 1e21', { size: 1e21 }, 'size'],
    ['size Infinity', { size: Number.POSITIVE_INFINITY }, 'size'],
    ['size -1', { size: -1 }, 'size'],
    ['size "abc"', { size: 'abc' }, 'size'],
  ] as const)(
    'over-precise or malformed input is refused, never rounded: %s',
    async (_name, over, field) => {
      const { ctx, nonce, tickSize, signTypedData } = makeCtx();
      await expectInvalidAsync(
        () => buildLimitOrder(limit(over as Partial<LimitOrderArgs>), ctx),
        field,
      );
      expect(tickSize).not.toHaveBeenCalled();
      expect(nonce).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
    },
  );

  test.each([
    ['0.999999', 'below 1 share'],
    ['0.0005', 'a dust size'],
    ['0', 'zero'],
  ])('size %s (%s) is refused by the size floor', async (size) => {
    const { ctx, nonce, signTypedData } = makeCtx();
    await expectInvalidAsync(
      () => buildLimitOrder(limit({ size }), ctx),
      'size',
    );
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('exactly 1 share is the smallest size', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildLimitOrder(limit({ size: '1' }), ctx);
    expect(order.takerAmount).toBe(1_000_000n);
  });
});

describe('buildLimitOrder: market tick size', () => {
  test('a price that is not a multiple of the tick size is refused (0.015 on 0.01)', async () => {
    const { ctx, nonce, signTypedData } = makeCtx({
      tickSize: async () => '0.01',
    });
    const error = await expectInvalidAsync(
      () => buildLimitOrder(limit({ price: '0.015' }), ctx),
      'price',
    );
    expect(error.message).toContain('0.01');
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('a multiple of the tick size passes (0.02 on 0.01)', async () => {
    const { ctx } = makeCtx({ tickSize: async () => '0.01' });
    const { order } = await buildLimitOrder(limit({ price: '0.02' }), ctx);
    expect(gatewayTick('BUY', order.makerAmount, order.takerAmount)).toBe(20n);
  });

  test('0.001 is not a multiple of 0.01', async () => {
    const { ctx } = makeCtx({ tickSize: async () => '0.01' });
    await expectInvalidAsync(
      () => buildLimitOrder(limit({ price: '0.001' }), ctx),
      'price',
    );
  });

  test('every 0.001 is fine on a 0.001 market', async () => {
    const { ctx } = makeCtx();
    for (const price of ['0.001', '0.015', '0.999']) {
      await buildLimitOrder(limit({ price }), ctx);
    }
  });

  test.each([
    ['not a number', 'abc'],
    ['finer than 0.001', '0.0001'],
    ['zero', '0'],
    ['one', '1'],
    ['empty', ''],
  ])(
    'a tick size from the server that is %s is refused and nothing is signed',
    async (_name, answer) => {
      const { ctx, nonce, signTypedData } = makeCtx({
        tickSize: async () => answer,
      });
      await expectInvalidAsync(() => buildLimitOrder(limit(), ctx), 'tickSize');
      expect(nonce).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
    },
  );
});

describe('buildLimitOrder: order type and postOnly', () => {
  test('the default type is GTC and postOnly is false', async () => {
    const { ctx } = makeCtx();
    const built = await buildLimitOrder(limit(), ctx);
    expect(built.orderType).toBe('GTC');
    expect(built.postOnly).toBe(false);
  });

  test.each(['GTC', 'FOK', 'FAK'] as const)(
    'type %s needs no expiration and signs expiration 0',
    async (type) => {
      const { ctx, nowSec } = makeCtx();
      const built = await buildLimitOrder(limit({ type }), ctx);
      expect(built.orderType).toBe(type);
      expect(built.order.expiration).toBe(0n);
      expect(built.wire.expiration).toBe('0');
      expect(nowSec).not.toHaveBeenCalled();
    },
  );

  test.each(['FOK', 'FAK'] as const)(
    'postOnly with %s is a UserInputError',
    async (type) => {
      const { ctx, nonce, tickSize } = makeCtx();
      await expectInvalidAsync(
        () => buildLimitOrder(limit({ type, postOnly: true }), ctx),
        'postOnly',
      );
      expect(nonce).not.toHaveBeenCalled();
      expect(tickSize).not.toHaveBeenCalled();
    },
  );

  test('postOnly: false with FOK is fine', async () => {
    const { ctx } = makeCtx();
    const built = await buildLimitOrder(
      limit({ type: 'FOK', postOnly: false }),
      ctx,
    );
    expect(built.postOnly).toBe(false);
  });

  test('postOnly is allowed with GTC and GTD', async () => {
    const { ctx } = makeCtx();
    const gtc = await buildLimitOrder(limit({ postOnly: true }), ctx);
    expect(gtc.postOnly).toBe(true);
    expect(gtc.orderType).toBe('GTC');
    const gtd = await buildLimitOrder(
      limit({ type: 'GTD', postOnly: true, expiration: NOW + 60 }),
      ctx,
    );
    expect(gtd.postOnly).toBe(true);
    expect(gtd.orderType).toBe('GTD');
  });

  test.each([
    ['postOnly', { postOnly: 'yes' }],
    ['type', { type: 'IOC' }],
    ['type', { type: 'gtc' }],
    ['type', { type: null }],
    ['side', { side: 'buy' }],
    ['side', { side: 0 }],
    ['side', { side: undefined }],
  ])('a bad %s (%o) is a UserInputError', async (field, over) => {
    const { ctx, nonce, tickSize } = makeCtx();
    await expectInvalidAsync(
      () =>
        buildLimitOrder(limit(over as unknown as Partial<LimitOrderArgs>), ctx),
      field,
    );
    expect(nonce).not.toHaveBeenCalled();
    expect(tickSize).not.toHaveBeenCalled();
  });
});

describe('buildLimitOrder: expiration', () => {
  const gtd = (expiration?: Date | number): LimitOrderArgs =>
    limit({ type: 'GTD', ...(expiration === undefined ? {} : { expiration }) });

  test('GTD requires an expiration', async () => {
    const { ctx, nonce, tickSize } = makeCtx();
    await expectInvalidAsync(() => buildLimitOrder(gtd(), ctx), 'expiration');
    expect(nonce).not.toHaveBeenCalled();
    expect(tickSize).not.toHaveBeenCalled();
  });

  test('an expiration of exactly nowSec() is refused', async () => {
    const { ctx, nonce, signTypedData } = makeCtx();
    await expectInvalidAsync(
      () => buildLimitOrder(gtd(NOW), ctx),
      'expiration',
    );
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('an expiration of nowSec() + 1 passes and is signed as is', async () => {
    const { ctx } = makeCtx();
    const { order, wire } = await buildLimitOrder(gtd(NOW + 1), ctx);
    expect(order.expiration).toBe(BigInt(NOW + 1));
    expect(wire.expiration).toBe(String(NOW + 1));
  });

  test('an expiration in the past and 0 are refused', async () => {
    const { ctx } = makeCtx();
    await expectInvalidAsync(
      () => buildLimitOrder(gtd(NOW - 1), ctx),
      'expiration',
    );
    await expectInvalidAsync(() => buildLimitOrder(gtd(0), ctx), 'expiration');
  });

  test('the check uses ctx.nowSec(), not the local clock', async () => {
    const localSec = Math.floor(Date.now() / 1000);
    // The server is a day behind the local clock: local now+60 is far in the server's future.
    const behind = makeCtx({ nowSec: () => localSec - 86_400 });
    await buildLimitOrder(gtd(localSec + 60), behind.ctx);
    // The server is a day ahead: local now+60 is already in the server's past.
    const ahead = makeCtx({ nowSec: () => localSec + 86_400 });
    await expectInvalidAsync(
      () => buildLimitOrder(gtd(localSec + 60), ahead.ctx),
      'expiration',
    );
  });

  test('a Date is converted to whole seconds, rounding down', async () => {
    const { ctx } = makeCtx();
    const date = new Date((NOW + 90) * 1000 + 999);
    const { order, wire } = await buildLimitOrder(gtd(date), ctx);
    expect(order.expiration).toBe(BigInt(NOW + 90));
    expect(wire.expiration).toBe(String(NOW + 90));
  });

  test('a Date that floors to nowSec() is refused', async () => {
    const { ctx } = makeCtx();
    await expectInvalidAsync(
      () => buildLimitOrder(gtd(new Date(NOW * 1000 + 999)), ctx),
      'expiration',
    );
  });

  test('an invalid Date is a UserInputError', async () => {
    const { ctx } = makeCtx();
    await expectInvalidAsync(
      () => buildLimitOrder(gtd(new Date(Number.NaN)), ctx),
      'expiration',
    );
  });

  test('milliseconds passed as a number are refused, and the message says so', async () => {
    const { ctx, nonce, signTypedData } = makeCtx();
    const error = await expectInvalidAsync(
      () => buildLimitOrder(gtd(Date.now() + 60_000), ctx),
      'expiration',
    );
    expect(error.message).toContain('milliseconds');
    const exact = await expectInvalidAsync(
      () => buildLimitOrder(gtd(100_000_000_001), ctx),
      'expiration',
    );
    expect(exact.message).toContain('milliseconds');
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('1e11 seconds is the last accepted number (and is far in the future)', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildLimitOrder(gtd(1e11), ctx);
    expect(order.expiration).toBe(100_000_000_000n);
  });

  test.each([
    ['a fraction', NOW + 0.5],
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a bigint', BigInt(NOW + 60)],
    ['a string', String(NOW + 60)],
    ['null', null],
  ])('an expiration that is %s is refused', async (_name, expiration) => {
    const { ctx } = makeCtx();
    await expectInvalidAsync(
      () => buildLimitOrder(gtd(expiration as unknown as number), ctx),
      'expiration',
    );
  });

  test.each(['GTC', 'FOK', 'FAK'] as const)(
    'an expiration with %s is a UserInputError, not ignored',
    async (type) => {
      const { ctx, nonce, tickSize } = makeCtx();
      await expectInvalidAsync(
        () => buildLimitOrder(limit({ type, expiration: NOW + 60 }), ctx),
        'expiration',
      );
      await expectInvalidAsync(
        () => buildLimitOrder(limit({ type, expiration: new Date() }), ctx),
        'expiration',
      );
      expect(nonce).not.toHaveBeenCalled();
      expect(tickSize).not.toHaveBeenCalled();
    },
  );

  test('a nowSec() that is not a finite number is refused rather than waving the order through', async () => {
    const { ctx } = makeCtx({ nowSec: () => Number.NaN });
    await expect(buildLimitOrder(gtd(NOW + 60), ctx)).rejects.toBeInstanceOf(
      UserInputError,
    );
  });
});

describe('buildLimitOrder: token id', () => {
  test('a decimal string is converted to a bigint exactly', async () => {
    const { ctx } = makeCtx();
    const max = UINT256_MAX.toString();
    const { order, wire } = await buildLimitOrder(limit({ tokenId: max }), ctx);
    expect(order.tokenId).toBe(UINT256_MAX);
    expect(wire.tokenId).toBe(max);
  });

  test.each([
    ['a number', 4660],
    ['a bigint', 4660n],
    ['hex', '0x1234'],
    ['empty', ''],
    ['signed', '-1'],
    ['with a plus', '+1'],
    ['with a dot', '1.5'],
    ['with whitespace', ' 1'],
    ['an exponent', '1e3'],
    ['79 digits', '1'.repeat(79)],
    ['2^256', (2n ** 256n).toString()],
    ['undefined', undefined],
  ])(
    'a token id that is %s is refused before any call',
    async (_name, tokenId) => {
      const { ctx, nonce, tickSize } = makeCtx();
      await expectInvalidAsync(
        () => buildLimitOrder(limit({ tokenId: tokenId as string }), ctx),
        'tokenId',
      );
      expect(nonce).not.toHaveBeenCalled();
      expect(tickSize).not.toHaveBeenCalled();
    },
  );
});

describe('args', () => {
  test.each([null, undefined, 'order', 5])(
    'args %o are refused as a UserInputError',
    async (args) => {
      const { ctx, nonce } = makeCtx();
      await expect(
        buildLimitOrder(args as unknown as LimitOrderArgs, ctx),
      ).rejects.toBeInstanceOf(UserInputError);
      await expect(
        buildMarketOrder(args as unknown as MarketOrderArgs, ctx),
      ).rejects.toBeInstanceOf(UserInputError);
      expect(nonce).not.toHaveBeenCalled();
    },
  );
});

describe('buildLimitOrder: failures sign nothing', () => {
  test('if ctx.nonce() throws, the error propagates and nothing is signed', async () => {
    const failure = new Error('nonce lookup down');
    const { ctx, signTypedData } = makeCtx({
      nonce: async () => {
        throw failure;
      },
    });
    await expect(buildLimitOrder(limit(), ctx)).rejects.toBe(failure);
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('if ctx.tickSize() throws, the error propagates and nothing is signed', async () => {
    const failure = new Error('tick size down');
    const { ctx, nonce, signTypedData } = makeCtx({
      tickSize: async () => {
        throw failure;
      },
    });
    await expect(buildLimitOrder(limit(), ctx)).rejects.toBe(failure);
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('a nonce that is not a bigint in uint128 is refused and nothing is signed', async () => {
    for (const bad of [5, -1n, 2n ** 128n]) {
      const { ctx, signTypedData } = makeCtx({
        nonce: async () => bad as bigint,
      });
      await expectInvalidAsync(() => buildLimitOrder(limit(), ctx), 'nonce');
      expect(signTypedData).not.toHaveBeenCalled();
    }
  });
});

describe('buildMarketOrder', () => {
  test('market BUY 4.1 USDC: makerAmount 4_100_000 at the cap tick 999', async () => {
    const { ctx } = makeCtx();
    const built = await buildMarketOrder(market({ amount: '4.1' }), ctx);
    expect(built.order.makerAmount).toBe(4_100_000n);
    expect(built.order.takerAmount).toBe(4_104_104n);
    expect(
      gatewayTick('BUY', built.order.makerAmount, built.order.takerAmount),
    ).toBe(999n);
    expect(built.order.side).toBe(0);
    expect(built.wire.side).toBe('BUY');
    expect(built.wire.makerAmount).toBe('4100000');
  });

  test('the defaults are FAK, postOnly false, expiration 0, zero beneficiary, zero identifier and metadata', async () => {
    const { ctx } = makeCtx();
    const built = await buildMarketOrder(market(), ctx);
    expect(built.orderType).toBe('FAK');
    expect(built.postOnly).toBe(false);
    expect(built.order.expiration).toBe(0n);
    expect(built.order.beneficiary).toBe(zeroAddress);
    expect(built.order.identifier).toBe(ZERO_IDENTIFIER);
    expect(built.order.metadata).toBe(ZERO_METADATA);
    expect(built.order.maker).toBe(OWNER);
    expect(built.order.signer).toBe(OWNER);
    expect(built.order.signatureType).toBe(0);
    expect(built.order.nonce).toBe(NONCE);
    expect(built.order.tokenId).toBe(BigInt(TOKEN));
  });

  test('a number amount gives the same order as the equivalent string', async () => {
    const { ctx } = makeCtx();
    const a = await buildMarketOrder(market({ amount: 4.1 }), ctx);
    const b = await buildMarketOrder(market({ amount: '4.1' }), ctx);
    expect(a.order.makerAmount).toBe(b.order.makerAmount);
    expect(a.order.takerAmount).toBe(b.order.takerAmount);
  });

  test('FOK is allowed', async () => {
    const { ctx } = makeCtx();
    const built = await buildMarketOrder(market({ type: 'FOK' }), ctx);
    expect(built.orderType).toBe('FOK');
    expect(built.postOnly).toBe(false);
  });

  test.each(['GTC', 'GTD', 'IOC', ''])('type %s is refused', async (type) => {
    const { ctx, nonce, signTypedData } = makeCtx();
    await expectInvalidAsync(
      () => buildMarketOrder(market({ type: type as 'FAK' }), ctx),
      'type',
    );
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test('postOnly and expiration are never set: passing them is refused', async () => {
    const { ctx, nonce } = makeCtx();
    await expectInvalidAsync(
      () =>
        buildMarketOrder(
          { ...market(), postOnly: true } as unknown as MarketOrderArgs,
          ctx,
        ),
      'postOnly',
    );
    await expectInvalidAsync(
      () =>
        buildMarketOrder(
          { ...market(), expiration: NOW + 60 } as unknown as MarketOrderArgs,
          ctx,
        ),
      'expiration',
    );
    expect(nonce).not.toHaveBeenCalled();
  });

  test('BUY: takerAmount = floor(makerAmount * 1000 / 999) and the gateway tick is the cap 999', async () => {
    const { ctx } = makeCtx();
    for (const amount of [
      '0.999',
      '1',
      '4.1',
      '10.123457',
      '1000000',
      '99999.999999',
    ]) {
      const { order } = await buildMarketOrder(market({ amount }), ctx);
      expect(order.takerAmount).toBe((order.makerAmount * 1000n) / 999n);
      expect(gatewayTick('BUY', order.makerAmount, order.takerAmount)).toBe(
        999n,
      );
    }
  });

  test('BUY: 0.999 USDC is the smallest amount (1 share at the cap)', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildMarketOrder(market({ amount: '0.999' }), ctx);
    expect(order.makerAmount).toBe(999_000n);
    expect(order.takerAmount).toBe(1_000_000n);
    const error = await expectInvalidAsync(
      () => buildMarketOrder(market({ amount: '0.998999' }), ctx),
      'amount',
    );
    expect(error.message).toBe(
      'amount must be at least 0.999 USDC (1 share at the 0.999 cap)',
    );
  });

  test('BUY: a tiny amount gets the minimum-amount message, in USDC', async () => {
    const { ctx, nonce, signTypedData } = makeCtx();
    for (const amount of ['0.000001', '0.000999', '0.5']) {
      const error = await expectInvalidAsync(
        () => buildMarketOrder(market({ side: 'BUY', amount }), ctx),
        'amount',
      );
      expect(error.message).toBe(
        'amount must be at least 0.999 USDC (1 share at the 0.999 cap)',
      );
    }
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });

  test.each(['BUY', 'SELL'] as Side[])(
    '%s: an amount over the u64 limit says amount, not sizeMicro',
    async (side) => {
      const { ctx, nonce } = makeCtx();
      // 2e13 whole units is 2e19 micro-units: above 2^64 - 1 (about 1.8447e19).
      const error = await expectInvalidAsync(
        () => buildMarketOrder(market({ side, amount: '20000000000000' }), ctx),
        'amount',
      );
      expect(error.message).toContain('u64');
      expect(error.message).not.toContain('sizeMicro');
      expect(nonce).not.toHaveBeenCalled();
    },
  );

  test('BUY: the taker, not the maker, can be what exceeds the u64 limit', async () => {
    const { ctx } = makeCtx();
    // The maker fits in u64 (1.8445e19) but floor(maker * 1000 / 999) does not.
    const error = await expectInvalidAsync(
      () => buildMarketOrder(market({ amount: '18445000000000' }), ctx),
      'amount',
    );
    expect(error.message).toContain('u64');
    expect(error.message).not.toContain('sizeMicro');
  });

  test('every market size-limit message names amount and never sizeMicro', async () => {
    const { ctx } = makeCtx();
    const amounts: Array<[Side, string]> = [
      ['BUY', '0.000001'],
      ['BUY', '0.998999'],
      ['SELL', '0.999999'],
      ['SELL', '0.000001'],
      ['BUY', '20000000000000'],
      ['SELL', '20000000000000'],
    ];
    for (const [side, amount] of amounts) {
      const error = await expectInvalidAsync(
        () => buildMarketOrder(market({ side, amount }), ctx),
        'amount',
      );
      expect(error.message).not.toMatch(/sizeMicro|\bsize\b/);
    }
  });

  test('SELL: amount is shares, the taker is the 0.001 floor (tick 1)', async () => {
    const { ctx } = makeCtx();
    const built = await buildMarketOrder(
      market({ side: 'SELL', amount: '5.5' }),
      ctx,
    );
    expect(built.order.makerAmount).toBe(5_500_000n);
    expect(built.order.takerAmount).toBe(5_500n);
    expect(
      gatewayTick('SELL', built.order.makerAmount, built.order.takerAmount),
    ).toBe(1n);
    expect(built.order.side).toBe(1);
    expect(built.wire.side).toBe('SELL');
    expect(built.orderType).toBe('FAK');
    expect(built.postOnly).toBe(false);
  });

  test('SELL: the taker is floor(maker / 1000) and equals deriveAmounts at tick 1', async () => {
    const { ctx } = makeCtx();
    for (const amount of ['1', '1.000001', '153.641122', '123456.789']) {
      const { order } = await buildMarketOrder(
        market({ side: 'SELL', amount }),
        ctx,
      );
      expect(order.takerAmount).toBe(order.makerAmount / 1000n);
      expect({
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
      }).toEqual(deriveAmounts('SELL', 1n, order.makerAmount));
      expect(gatewayTick('SELL', order.makerAmount, order.takerAmount)).toBe(
        1n,
      );
    }
  });

  test('SELL: below 1 share is refused', async () => {
    const { ctx, nonce, signTypedData } = makeCtx();
    for (const amount of ['0.999999', '0.5', '0.000001']) {
      const error = await expectInvalidAsync(
        () => buildMarketOrder(market({ side: 'SELL', amount }), ctx),
        'amount',
      );
      expect(error.message).toBe('amount must be at least 1 share');
    }
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    const ok = await buildMarketOrder(
      market({ side: 'SELL', amount: '1' }),
      ctx,
    );
    expect(ok.order.makerAmount).toBe(1_000_000n);
  });

  test.each(['BUY', 'SELL'] as Side[])(
    '%s: zero and over-precise amounts are refused, never rounded',
    async (side) => {
      const { ctx, nonce, signTypedData } = makeCtx();
      for (const amount of [
        0,
        '0',
        '1.0000001',
        1e-7,
        1e21,
        -1,
        Number.NaN,
        '',
        'abc',
      ]) {
        await expectInvalidAsync(
          () => buildMarketOrder(market({ side, amount }), ctx),
          'amount',
        );
      }
      expect(nonce).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
    },
  );

  test('a bad side or token id is refused before any call', async () => {
    const { ctx, nonce } = makeCtx();
    await expectInvalidAsync(
      () => buildMarketOrder(market({ side: 'buy' as Side }), ctx),
      'side',
    );
    await expectInvalidAsync(
      () => buildMarketOrder(market({ tokenId: '0x12' }), ctx),
      'tokenId',
    );
    expect(nonce).not.toHaveBeenCalled();
  });

  test('nonce is called once per build, and the cap price needs no tick-size lookup', async () => {
    const { ctx, nonce, tickSize } = makeCtx();
    await buildMarketOrder(market(), ctx);
    await buildMarketOrder(market({ side: 'SELL', amount: '3' }), ctx);
    expect(nonce).toHaveBeenCalledTimes(2);
    expect(tickSize).not.toHaveBeenCalled();
  });

  test('orderHash and the EOA signature check out', async () => {
    const { ctx } = makeCtx();
    const { order, orderHash, wire } = await buildMarketOrder(market(), ctx);
    expect(orderHash).toBe(hashOrder(order, DOMAIN));
    expect(
      await recoverTypedDataAddress({
        ...orderTypedData(order, DOMAIN),
        signature: wire.signature,
      }),
    ).toBe(OWNER);
  });

  test('smart wallet: maker = signer = the smart wallet and the signature is 0x00-prefixed', async () => {
    const { ctx } = makeCtx({ identity: smartWalletIdentity });
    const { order, wire } = await buildMarketOrder(market(), ctx);
    expect(order.maker).toBe(ACCOUNT as Address);
    expect(order.signer).toBe(ACCOUNT as Address);
    expect(order.signatureType).toBe(3);
    expect(wire.signature.startsWith('0x00')).toBe(true);
  });

  test('the salt is random when not given', async () => {
    const { ctx } = makeCtx();
    const a = await buildMarketOrder(market(), ctx);
    const b = await buildMarketOrder(market(), ctx);
    expect(a.order.salt).not.toBe(b.order.salt);
    expect(a.order.salt).toBeLessThan(2n ** 64n);
  });
});

describe('buildMarketOrder: a worst price', () => {
  test('BUY with maxPrice is signed at that price: 1 USDC at 0.04 buys up to 25 shares', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildMarketOrder(
      market({ amount: '1', maxPrice: '0.04' }),
      ctx,
    );
    expect(order.makerAmount).toBe(1_000_000n);
    expect(order.takerAmount).toBe(25_000_000n);
    expect(gatewayTick('BUY', order.makerAmount, order.takerAmount)).toBe(40n);
  });

  test('BUY: the taker is floor(maker * 1000 / cap) and always reads back as the cap', async () => {
    const { ctx } = makeCtx();
    for (const [amount, maxPrice, cap] of [
      ['4.1', '0.57', 570n],
      ['10.123457', '0.333', 333n],
      ['0.999', '0.999', 999n],
      ['99999.999999', '0.001', 1n],
    ] as const) {
      const { order } = await buildMarketOrder(
        market({ amount, maxPrice }),
        ctx,
      );
      expect(order.takerAmount).toBe((order.makerAmount * 1000n) / cap);
      expect(gatewayTick('BUY', order.makerAmount, order.takerAmount)).toBe(
        cap,
      );
    }
  });

  test('SELL with minPrice is signed at that price: 5.5 shares for at least 0.6 each', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildMarketOrder(
      market({ side: 'SELL', amount: '5.5', minPrice: '0.6' }),
      ctx,
    );
    expect(order.makerAmount).toBe(5_500_000n);
    expect(order.takerAmount).toBe(3_300_000n);
    expect(gatewayTick('SELL', order.makerAmount, order.takerAmount)).toBe(
      600n,
    );
  });

  test('BUY: the smallest amount buys 1 share at the cap', async () => {
    const { ctx } = makeCtx();
    const { order } = await buildMarketOrder(
      market({ amount: '0.5', maxPrice: '0.5' }),
      ctx,
    );
    expect(order.takerAmount).toBe(1_000_000n);
    const error = await expectInvalidAsync(
      () =>
        buildMarketOrder(market({ amount: '0.499999', maxPrice: '0.5' }), ctx),
      'amount',
    );
    expect(error.message).toBe(
      'amount must be at least 0.5 USDC (1 share at the 0.5 cap)',
    );
  });

  test('a cap is checked against the market tick size, once, before anything is signed', async () => {
    const tickSize = vi.fn(async (_tokenId: string) => '0.01');
    const { ctx, nonce, signTypedData } = makeCtx({ tickSize });
    const error = await expectInvalidAsync(
      () => buildMarketOrder(market({ maxPrice: '0.045' }), ctx),
      'maxPrice',
    );
    expect(error.message).toBe(
      'maxPrice must be a multiple of the market tick size 0.01',
    );
    await expectInvalidAsync(
      () =>
        buildMarketOrder(
          market({ side: 'SELL', amount: '2', minPrice: '0.015' }),
          ctx,
        ),
      'minPrice',
    );
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
    const { order } = await buildMarketOrder(market({ maxPrice: '0.05' }), ctx);
    expect(gatewayTick('BUY', order.makerAmount, order.takerAmount)).toBe(50n);
    expect(tickSize).toHaveBeenCalledTimes(3);
    expect(tickSize).toHaveBeenCalledWith(BigInt(TOKEN).toString());
  });

  test('maxPrice is for a buy and minPrice for a sell: the other side refuses them', async () => {
    const { ctx, nonce } = makeCtx();
    const sell = await expectInvalidAsync(
      () =>
        buildMarketOrder(
          market({ side: 'SELL', amount: '2', maxPrice: '0.5' }),
          ctx,
        ),
      'maxPrice',
    );
    expect(sell.message).toBe(
      'maxPrice is for a market buy; a market sell takes minPrice',
    );
    const buy = await expectInvalidAsync(
      () => buildMarketOrder(market({ minPrice: '0.5' }), ctx),
      'minPrice',
    );
    expect(buy.message).toBe(
      'minPrice is for a market sell; a market buy takes maxPrice',
    );
    expect(nonce).not.toHaveBeenCalled();
  });

  test.each(['0', '1', '0.0001', '1.5', '-0.5', 'abc', ''])(
    'a cap of %j is refused, never rounded',
    async (maxPrice) => {
      const { ctx, nonce, tickSize } = makeCtx();
      await expectInvalidAsync(
        () => buildMarketOrder(market({ maxPrice }), ctx),
        'maxPrice',
      );
      expect(tickSize).not.toHaveBeenCalled();
      expect(nonce).not.toHaveBeenCalled();
    },
  );

  test('a cap at the extreme price is the same order as no cap, with no tick-size lookup', async () => {
    const { ctx, tickSize } = makeCtx();
    const capped = await buildMarketOrder(
      market({ amount: '4.1', maxPrice: '0.999' }),
      ctx,
    );
    const plain = await buildMarketOrder(market({ amount: '4.1' }), ctx);
    expect(capped.order.makerAmount).toBe(plain.order.makerAmount);
    expect(capped.order.takerAmount).toBe(plain.order.takerAmount);
    const sell = await buildMarketOrder(
      market({ side: 'SELL', amount: '5', minPrice: '0.001' }),
      ctx,
    );
    expect(
      gatewayTick('SELL', sell.order.makerAmount, sell.order.takerAmount),
    ).toBe(1n);
    expect(tickSize).not.toHaveBeenCalled();
  });

  test('a capped order with an amount too small for one share is refused before the tick-size lookup', async () => {
    const { ctx, nonce, tickSize } = makeCtx();
    const error = await expectInvalidAsync(
      () => buildMarketOrder(market({ amount: '0.1', maxPrice: '0.5' }), ctx),
      'amount',
    );
    expect(error.message).toBe(
      'amount must be at least 0.5 USDC (1 share at the 0.5 cap)',
    );
    expect(tickSize).not.toHaveBeenCalled();
    expect(nonce).not.toHaveBeenCalled();
  });

  test('a failed tick-size read stops the build before the nonce and the signature', async () => {
    const failure = new Error('tick size unavailable');
    const { ctx, nonce, signTypedData } = makeCtx({
      tickSize: async () => {
        throw failure;
      },
    });
    await expect(
      buildMarketOrder(market({ maxPrice: '0.5' }), ctx),
    ).rejects.toBe(failure);
    expect(nonce).not.toHaveBeenCalled();
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
