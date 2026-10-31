// Code that docs/authentication.md quotes: type-checked, never run.

import {
  createSecureClient,
  type SecureClient,
  type WalletCredentials,
} from '@xomarket/client';
import { fileStore } from '@xomarket/client/node';
import { privateKey, signerFrom } from '@xomarket/client/viem';
import type { LocalAccount } from 'viem';

/** What the client holds: its wallet, and its credentials, which are secrets. */
export async function credentialsTour(client: SecureClient) {
  // #region credentials
  console.log(`Trading as ${client.wallet}`);
  console.log(JSON.stringify(client));
  const credentials = await client.exportCredentials();
  // #endregion credentials
  return credentials;
}

/** A client that uses credentials saved by an earlier one, instead of signing in for new ones. */
export async function savedCredentials(key: string, saved: WalletCredentials) {
  // #region saved-credentials
  const client = await createSecureClient({
    signer: privateKey(key),
    credentials: saved,
  });
  // #endregion saved-credentials
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

/** A client whose signer is a viem account: a local one, or one of a key management service. */
export async function accountClient(account: LocalAccount) {
  // #region signer-from-account
  const client = await createSecureClient({ signer: signerFrom(account) });
  // #endregion signer-from-account
  return client;
}

/** Lists the account's API keys, then replaces the one the client holds. */
export async function rotateKey(client: SecureClient) {
  // #region rotate-key
  for await (const page of client.listApiKeys()) {
    for (const key of page.items) {
      console.log(`${key.name} ${key.prefix}… expires ${key.expiresAt}`);
    }
  }
  await client.rotateCredentials();
  // #endregion rotate-key
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
