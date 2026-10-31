import { expect } from 'vitest';
import type { PublicClient, RewardsMaker } from '../src/index';
import type { MarketRewardsDetails, RewardPool } from '../src/models/rewards';
import { live } from './setup';

// Live data the tests of more than one file start from, found through the SDK with no
// credentials. Not a test file: nothing here runs on its own.

export interface Rewarded {
  conditionId: string;
  /** A scored day of the market, with makers. */
  epoch: number;
  makers: RewardsMaker[];
  /** A maker of that day: one with a score when the day has one. */
  maker: string;
  /** True when that maker has a score, so the wallet's day lists the market. */
  scored: boolean;
  rewards: MarketRewardsDetails;
  pools: RewardPool[];
}

let rewardedPromise: Promise<Rewarded> | undefined;

/**
 * A market of the reward pools that has a scored day with makers, found through the SDK: for
 * each pool that is not a Pulse window, the market's rewards say which days were scored, and
 * the makers of the latest one give a wallet.
 */
export function rewardedMarket(client: PublicClient): Promise<Rewarded> {
  rewardedPromise ??= (async () => {
    const page = await live('listRewardPools (setup)', () =>
      client.listRewardPools().firstPage(),
    );
    const pools = page.items;
    expect(pools.length, 'mainnet has reward pools').toBeGreaterThan(0);
    for (const pool of pools) {
      if (pool.groupId !== null) {
        // A Pulse window is paid by its group; the market itself has no rewards page.
        continue;
      }
      const rewards = await live(
        `fetchMarketRewards (${pool.conditionId})`,
        () => client.fetchMarketRewards({ conditionId: pool.conditionId }),
      );
      const scored = rewards.lifetime
        .filter(
          (row) =>
            row.scoredEpochs > 0 && /[1-9]/.test(row.totalScoredLiquidity),
        )
        .map((row) => row.latestEpoch);
      for (const epoch of [...new Set(scored)]) {
        const makers = await live(
          `listMarketRewardsMakers (${pool.conditionId}, ${epoch})`,
          () =>
            client
              .listMarketRewardsMakers({
                conditionId: pool.conditionId,
                epoch,
                pageSize: 20,
              })
              .firstPage(),
        );
        const best =
          makers.items.find((maker) => /[1-9]/.test(maker.score)) ??
          makers.items[0];
        if (best !== undefined) {
          return {
            conditionId: pool.conditionId,
            epoch,
            makers: makers.items,
            maker: best.wallet,
            scored: /[1-9]/.test(best.score),
            rewards,
            pools,
          };
        }
      }
    }
    throw new Error(
      'no market of the reward pools has a scored day with makers: the wallet reads have nothing to read',
    );
  })();
  return rewardedPromise;
}
