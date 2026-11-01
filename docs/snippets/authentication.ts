// Code that docs/authentication.md quotes: type-checked, never run.

import {
  createPublicClient,
  createSecureClient,
  type SecureClient,
  type Signer,
} from '@xomarket/client';
import { fileStore } from '@xomarket/client/node';
import { privateKey } from '@xomarket/client/viem';

/** A client that signs in with a private key. */
export async function signIn() {
  // #region sign-in
  const client = await createSecureClient({
    signer: privateKey(process.env.XO_PK ?? ''),
  });
  console.log(`Trading as ${client.wallet}`);
  // #endregion sign-in
  return client;
}

/** A client that keeps its credentials in files, across restarts. */
export async function fileStoreClient() {
  // #region file-store
  const client = await createSecureClient({
    signer: privateKey(process.env.XO_PK ?? ''),
    store: fileStore('./.xo-credentials'), // from @xomarket/client/node
  });
  // #endregion file-store
  return client;
}

/** A second client that uses the first one's credentials instead of signing in. */
export async function savedCredentials(client: SecureClient, signer: Signer) {
  // #region saved-credentials
  const saved = await client.exportCredentials(); // secret: never log it

  const again = await createSecureClient({ signer, credentials: saved });
  // #endregion saved-credentials
  return again;
}

/** Ends this process's use of the client. */
export async function closeClient(client: SecureClient) {
  // #region close
  await client.close();
  // #endregion close
}

/** Signs the wallet out for good, and goes on reading public data. */
export async function signOut(client: SecureClient) {
  // #region end-authentication
  const publicClient = await client.endAuthentication();
  // #endregion end-authentication
  return publicClient;
}

/** A client that trades from a key's smart wallet 0: the smart wallet trades, the key signs. */
export async function smartWalletClient() {
  // #region smart-wallet-address
  const signer = privateKey(process.env.XO_PK ?? '');
  const wallet = await createPublicClient().fetchSmartWalletAddress({
    owner: await signer.getAddress(),
    index: 0,
  });
  console.log(`Smart wallet 0: ${wallet}`);
  // #endregion smart-wallet-address

  // #region smart-wallet-client
  const client = await createSecureClient({ signer, wallet });
  // #endregion smart-wallet-client

  // #region setup
  const transaction = await client.setupTradingApprovals();
  console.log(transaction?.transactionHash ?? 'Nothing to set up');
  // #endregion setup
  return client;
}
