// Code that docs/errors.md and SDK_DIRECTION.md quote: type-checked, never run.

import {
  FetchMarketError,
  type PublicClient,
  RequestRejectedError,
} from '@xomarket/client';

export async function marketOrNull(client: PublicClient, slug: string) {
  // #region tell-apart
  try {
    return await client.fetchMarket({ slug });
  } catch (error) {
    if (error instanceof RequestRejectedError && error.status === 404) {
      return null;
    }
    throw error;
  }
  // #endregion tell-apart
}

export async function marketOrExplain(client: PublicClient, slug: string) {
  // #region error-guard
  try {
    return await client.fetchMarket({ slug });
  } catch (error) {
    if (FetchMarketError.isError(error)) {
      console.log(`${error.name} ${error.code}: ${error.message}`);
    }
    throw error;
  }
  // #endregion error-guard
}
