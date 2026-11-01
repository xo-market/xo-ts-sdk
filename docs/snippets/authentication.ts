// Code that docs/authentication.md quotes: type-checked, never run.

import { createSecureClient, type SecureClient } from '@xomarket/client';
import { fileStore } from '@xomarket/client/node';
import { privateKey, signerFrom } from '@xomarket/client/viem';
import type { LocalAccount } from 'viem';

/** A client that signs in with a private key. */
export async function signIn(key: string) {
  // #region sign-in
  const client = await createSecureClient({ signer: privateKey(key) });
  console.log(`Trading as ${client.wallet}`);
  // #endregion sign-in
  return client;
}

/** A client whose signer is a viem account: a local one, or one of a key management service. */
export async function accountClient(account: LocalAccount) {
  // #region signer-from-account
  const client = await createSecureClient({ signer: signerFrom(account) });
  // #endregion signer-from-account
  return client;
}

/** A client that keeps its credentials in files, across restarts. */
export async function fileStoreClient(key: string) {
  // #region file-store
  const client = await createSecureClient({
    signer: privateKey(key),
    store: fileStore('./.xo-credentials'),
  });
  // #endregion file-store
  return client;
}

/** A second client that uses the first one's credentials instead of signing in. */
export async function savedCredentials(client: SecureClient, key: string) {
  // #region saved-credentials
  const saved = await client.exportCredentials();

  const again = await createSecureClient({
    signer: privateKey(key),
    credentials: saved,
  });
  // #endregion saved-credentials
  return again;
}

/** Ends this process's use of the client: the credentials stay valid. */
export async function closeClient(client: SecureClient) {
  // #region close
  await client.close();
  // #endregion close
}

/** Signs the wallet out for good, and goes on reading public data. */
export async function signOut(client: SecureClient) {
  // #region end-authentication
  const publicClient = await client.endAuthentication();
  const { items } = await publicClient.listMarkets().firstPage();
  // #endregion end-authentication
  return items;
}

/** Lists the account's API keys, then replaces the one the client holds. */
export async function rotateKey(client: SecureClient) {
  // #region rotate-key
  for await (const page of client.listApiKeys()) {
    for (const key of page.items) {
      console.log(key.name, key.expiresAt);
    }
  }
  await client.rotateCredentials();
  // #endregion rotate-key
}
