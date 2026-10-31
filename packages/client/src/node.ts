// The Node-only entry, `@xomarket/client/node`: what needs a Node builtin. The universal entry
// (`src/index.ts`) never imports this file.

/**
 * `@xomarket/client/node`: what needs a Node builtin: the file credential store
 * (`fileStore`).
 *
 * @module @xomarket/client/node
 */

export { fileStore } from './auth/fileStore';
export type {
  BackendCredential,
  CredentialStore,
  StoredCredentials,
} from './auth/store';
// Named by `StoredCredentials`, so a custom store can be typed from this entry alone.
export type { OrderbookCredential } from './signing/hmac';
