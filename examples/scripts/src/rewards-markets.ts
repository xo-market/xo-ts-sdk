import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();

const { items } = await client.listRewardPools().firstPage();

const rows = items.flatMap((pool) =>
  pool.programmes
    .filter((programme) => programme.currency === 'USDC' && programme.active)
    .map((programme) => ({
      market: pool.market?.slug ?? pool.conditionId,
      usdcPerDay: programme.dailyPool ?? 'N/A',
      minShares: programme.terms.minOrderSize ?? 'N/A',
      maxCentsFromMid: programme.terms.maxDistanceCents ?? 'N/A',
      ends: programme.endsAt ?? 'N/A',
    })),
);

console.log(`Found ${rows.length} markets that pay USDC rewards`);
console.table(rows);
