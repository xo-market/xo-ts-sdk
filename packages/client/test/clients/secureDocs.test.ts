import { describe, expect, test } from 'vitest';
import { capitalized, hoversOf } from '../helpers/hovers';

// What an editor shows on the members a secure client adds to a public one: each carries its
// whole public documentation in the hover, as the public members do. A member inherited from
// the public client shows the public client's documentation; one the secure client declares
// again (a read of a wallet, which defaults to its own) shows its own.

/** The members a secure client adds, and whether each can throw. */
const ADDED = {
  wallet: { kind: 'property', throws: false },
  endAuthentication: { kind: 'method', throws: true },
  close: { kind: 'method', throws: false },
  subscribe: { kind: 'method', throws: true },
  rotateCredentials: { kind: 'method', throws: true },
  exportCredentials: { kind: 'method', throws: true },
  createLimitOrder: { kind: 'method', throws: true },
  createMarketOrder: { kind: 'method', throws: true },
  placeLimitOrder: { kind: 'method', throws: true },
  placeMarketOrder: { kind: 'method', throws: true },
  postOrder: { kind: 'method', throws: true },
  postOrders: { kind: 'method', throws: true },
  postOrderBatch: { kind: 'method', throws: true },
  cancelOrder: { kind: 'method', throws: true },
  cancelOrders: { kind: 'method', throws: true },
  cancelAll: { kind: 'method', throws: true },
  cancelMarketOrders: { kind: 'method', throws: true },
  listOpenOrders: { kind: 'method', throws: true },
  fetchOrder: { kind: 'method', throws: true },
  listAccountTrades: { kind: 'method', throws: true },
  fetchAccountTrade: { kind: 'method', throws: true },
  sendOrderHeartbeat: { kind: 'method', throws: true },
  startOrderHeartbeat: { kind: 'method', throws: true },
  reconcileOrder: { kind: 'method', throws: true },
  fetchMarketCapacity: { kind: 'method', throws: true },
  listPositions: { kind: 'method', throws: true },
  fetchPortfolioValue: { kind: 'method', throws: true },
  fetchUserPnl: { kind: 'method', throws: true },
  listActivity: { kind: 'method', throws: true },
  fetchUserStats: { kind: 'method', throws: true },
  fetchProfile: { kind: 'method', throws: true },
  listApiKeys: { kind: 'method', throws: true },
  fetchBalances: { kind: 'method', throws: true },
  fetchTradingApprovalsState: { kind: 'method', throws: true },
  setupTradingApprovals: { kind: 'method', throws: true },
  mergePositions: { kind: 'method', throws: true },
  redeemPositions: { kind: 'method', throws: true },
  redeemAllPositions: { kind: 'method', throws: true },
  transferErc20: { kind: 'method', throws: true },
  listBridgeAssets: { kind: 'method', throws: true },
  quoteDeposit: { kind: 'method', throws: true },
  quoteWithdrawal: { kind: 'method', throws: true },
  createDeposit: { kind: 'method', throws: true },
  withdraw: { kind: 'method', throws: true },
  verifyBridgePayment: { kind: 'method', throws: true },
  fetchBridgePayment: { kind: 'method', throws: true },
  waitForBridgePayment: { kind: 'method', throws: true },
  listBridgePayments: { kind: 'method', throws: true },
  listRewardsLeaderboard: { kind: 'method', throws: true },
  fetchRewardsLeaderboardStanding: { kind: 'method', throws: true },
  fetchUserRewards: { kind: 'method', throws: true },
  fetchUserRewardsEpoch: { kind: 'method', throws: true },
  listUserRewardsOrders: { kind: 'method', throws: true },
} as const;
const MEMBERS = Object.keys(ADDED) as Array<keyof typeof ADDED>;
const INHERITED = ['fetchMarket', 'listMarkets', 'closeSubscriptions'];

describe('what an editor shows on a member of a secure client', () => {
  const hovers = hoversOf({
    files: ['clients/secure.ts'],
    prelude: [
      "import type { SecureClient } from './clients/secure';",
      'declare const client: SecureClient;',
    ],
    receiver: 'client',
    members: [...MEMBERS, ...INHERITED],
  });

  test('every member has a hover', () => {
    expect([...hovers.keys()].sort()).toEqual(
      [...MEMBERS, ...INHERITED].sort(),
    );
  });

  test.each(MEMBERS)('%s: the signature and a summary', (member) => {
    const hover = hovers.get(member);
    // A generic member shows its type parameters first: `subscribe<const S ...>(`.
    const opening =
      ADDED[member].kind === 'method'
        ? [
            `(method) SecureClient.${member}(`,
            `(method) SecureClient.${member}<`,
          ]
        : [`(property) SecureClient.${member}: `];
    expect(opening.some((start) => hover?.signature.startsWith(start))).toBe(
      true,
    );
    expect(hover?.summary.length).toBeGreaterThan(40);
    // The documentation that points elsewhere is not the documentation.
    expect(hover?.summary).not.toMatch(/documentation is on/i);
  });

  test.each(MEMBERS)('%s: a @param for each parameter, in order', (member) => {
    const hover = hovers.get(member);
    const described = hover?.tags
      .filter((tag) => tag.name === 'param')
      .map((tag) => tag.text.split(' ')[0]);
    expect(described).toEqual(hover?.parameters);
  });

  test.each(MEMBERS.filter((m) => ADDED[m].throws))(
    '%s: a @throws that names its error union',
    (member) => {
      const throws = hovers
        .get(member)
        ?.tags.filter((t) => t.name === 'throws');
      expect(throws).toHaveLength(1);
      expect(
        throws?.[0]?.text.startsWith(`{${capitalized(member)}Error}`),
      ).toBe(true);
    },
  );

  test.each(MEMBERS.filter((m) => !ADDED[m].throws))(
    '%s: no @throws, and the summary says why it cannot fail',
    (member) => {
      const hover = hovers.get(member);
      expect(hover?.tags.filter((t) => t.name === 'throws')).toEqual([]);
      if (ADDED[member].kind === 'method') {
        expect(hover?.summary).toMatch(/never rejects/);
      }
    },
  );

  test.each(MEMBERS)(
    '%s: an @example that uses it, without imports',
    (member) => {
      const examples = hovers
        .get(member)
        ?.tags.filter((t) => t.name === 'example');
      expect(examples).toHaveLength(1);
      expect(examples?.[0]?.text).toContain(
        ADDED[member].kind === 'method'
          ? `client.${member}(`
          : `client.${member}`,
      );
      expect(examples?.[0]?.text).not.toMatch(/^\s*import /m);
    },
  );

  test.each(INHERITED)(
    '%s: the documentation of the public client',
    (member) => {
      const hover = hovers.get(member);
      expect(
        hover?.signature.startsWith(`(method) PublicClient.${member}(`),
      ).toBe(true);
      expect(hover?.tags.some((t) => t.name === 'example')).toBe(true);
      // Its error union, which says what a signed-in client adds.
      const throws = hover?.tags.filter((t) => t.name === 'throws');
      expect(throws).toHaveLength(1);
      expect(
        throws?.[0]?.text.startsWith(`{${capitalized(member)}Error}`),
      ).toBe(true);
    },
  );
});
