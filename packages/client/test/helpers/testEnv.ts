import {
  type EnvironmentConfig,
  production,
  resolveEnvironment,
} from '../../src/core/env';

/**
 * The environment unit tests run on: a fake chain on the reserved `.test` domain, so no test
 * can reach a real host. It has a sponsor and no bridge. The contracts are the mainnet
 * addresses, which the tests only ever use as opaque values.
 *
 * Built with `resolveEnvironment`, so it is validated and deep-frozen like any custom config.
 */
export const testEnv: EnvironmentConfig = resolveEnvironment({
  name: 'test',
  chainId: 31337,
  backendUrl: 'https://api.xo.test',
  backendSocketUrl: 'https://api.xo.test',
  orderbookUrl: 'https://orderbook.xo.test',
  orderbookMarketWsUrl: 'wss://orderbook.xo.test/ws/market',
  orderbookUserWsUrl: 'wss://orderbook.xo.test/ws/user',
  sponsorUrl: 'https://sponsor.xo.test',
  rpcUrl: 'https://rpc.xo.test',
  siweDomain: 'app.xo.test',
  siweUri: 'https://app.xo.test',
  contracts: { ...production.contracts },
  kernelVersion: '0.3.1',
});

/** `testEnv` plus the bridge, for the tests of `xo.bridge`. */
export const testEnvWithBridge: EnvironmentConfig = resolveEnvironment({
  ...testEnv,
  bridge: true,
});
