// Code that docs/README.md quotes: type-checked, never run.

// #region wallet-private-key
import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';

const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK ?? ''),
});

// #endregion wallet-private-key

export { client };
