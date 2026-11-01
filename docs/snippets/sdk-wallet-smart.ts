// Code that docs/README.md quotes: type-checked, never run.

// #region wallet-smart
import { createSecureClient } from '@xomarket/client';
import { privateKey } from '@xomarket/client/viem';

const client = await createSecureClient({
  signer: privateKey(process.env.XO_PK ?? ''),
  wallet: '0xYourSmartWalletAddress',
});

// #endregion wallet-smart

export { client };
