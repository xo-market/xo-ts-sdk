// The viem entry, `@xomarket/client/viem`: the signers made from a private key or a viem
// account or wallet client. The universal entry never imports this file.

/**
 * `@xomarket/client/viem`: the signers for a private key (`privateKey`) and for a viem
 * account or wallet client (`signerFrom`), and the `Signer` they make.
 *
 * @module @xomarket/client/viem
 */

export { privateKey, type Signer, signerFrom } from './wallet/publicSigner';
