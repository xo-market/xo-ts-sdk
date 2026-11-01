// Code that docs/README.md quotes: type-checked, never run.

import { createPublicClient } from '@xomarket/client';

const client = createPublicClient();

// #region errors
import { ListMarketsError, RateLimitError } from '@xomarket/client';

try {
  await client.listMarkets({ pageSize: 5 }).firstPage();
} catch (error) {
  if (!ListMarketsError.isError(error)) {
    throw error;
  }
  if (error instanceof RateLimitError) {
    console.log(`Rate limited. Try again in ${error.retryAfter} ms`);
  } else {
    console.log(`${error.code}: ${error.message}`);
  }
}
// #endregion errors
