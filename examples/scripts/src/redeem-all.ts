import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';
import { requireEnv } from './lib/env';

const client = await createSecureClient({
  signer: privateKey(requireEnv('XO_PK')),
});

const results = await client.redeemAllPositions();

for (const result of results) {
  if (result.ok) {
    console.log(
      `${result.conditionId}: redeemed in ${result.transaction.transactionHash}`,
    );
  } else {
    console.log(
      `${result.conditionId}: ${result.error.mayHaveLanded ? 'outcome unknown' : 'nothing sent'} (${result.error.code})`,
    );
  }
}
console.log(`${results.length} market(s) to redeem`);
