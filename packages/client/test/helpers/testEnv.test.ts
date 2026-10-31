import { describe, expect, it } from 'vitest';
import { production, resolveEnvironment } from '../../src/core/env';
import { testEnv, testEnvWithBridge } from './testEnv';

describe('testEnv', () => {
  it('testEnv passes resolveEnvironment and has no bridge', () => {
    const resolved = resolveEnvironment(testEnv);

    expect(resolved).toEqual(testEnv);
    expect(Object.isFrozen(testEnv)).toBe(true);
    expect(testEnv.name).toBe('test');
    expect(testEnv.chainId).toBe(31337);
    expect(testEnv.bridge).toBeUndefined();
    expect(testEnv.sponsorUrl).toBe('https://sponsor.xo.test');
    expect(testEnv.contracts).toEqual(production.contracts);
  });

  it('testEnvWithBridge has the bridge', () => {
    expect(resolveEnvironment(testEnvWithBridge)).toEqual(testEnvWithBridge);
    expect(Object.isFrozen(testEnvWithBridge)).toBe(true);
    expect(testEnvWithBridge.bridge).toBe(true);
    expect({ ...testEnvWithBridge, bridge: undefined }).toEqual({
      ...testEnv,
      bridge: undefined,
    });
  });

  it('every testEnv host ends in .test', () => {
    const urls = [
      testEnv.backendUrl,
      testEnv.backendSocketUrl,
      testEnv.orderbookUrl,
      testEnv.orderbookMarketWsUrl,
      testEnv.orderbookUserWsUrl,
      testEnv.sponsorUrl,
      testEnv.rpcUrl,
      testEnv.siweUri,
    ];
    for (const url of urls) {
      expect(new URL(url as string).hostname).toMatch(/\.test$/);
    }
    expect(testEnv.siweDomain).toMatch(/\.test$/);
  });
});
