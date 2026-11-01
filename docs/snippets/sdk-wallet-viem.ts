// Code that docs/README.md quotes: type-checked, never run.

// #region wallet-viem
import { createSecureClient } from '@xomarket/client';
import { signerFrom } from '@xomarket/client/viem';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.XO_PK as `0x${string}`);
const client = await createSecureClient({ signer: signerFrom(account) });

// #endregion wallet-viem

export { client };
