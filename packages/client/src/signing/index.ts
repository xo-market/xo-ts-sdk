// `@xomarket/client/signing`: the pure signing kit. Every function builds
// or hashes locally and does no I/O; the golden vectors in `test-vectors/` pin them.
//
// Explicit names only: never `export *`, and nothing from `./internal` or an
// internal helper (`isValidSecret` stays internal).

/**
 * `@xomarket/client/signing`: the pure signing kit, for advanced use. Every function builds or
 * hashes locally (orders, cancels, the orderbook's L1 and L2 headers, Kernel wrapping, EvNode
 * transactions) and does no I/O.
 *
 * @module @xomarket/client/signing
 */

// Named by `hashOrder`'s result.
export type { OrderHash } from '../core/types';
export {
  CANCEL_ALL_TYPES,
  CANCEL_ORDER_TYPES,
  cancelAllTypedData,
  cancelOrderTypedData,
} from './cancel';
export {
  CLOB_AUTH_MESSAGE,
  CLOB_AUTH_TYPES,
  type ClobAuthParams,
  clobAuthTypedData,
  l1Headers,
} from './clobAuth';
export {
  EVNODE_TX_TYPE,
  type EvAccessListItem,
  type EvCall,
  type EvTx,
  type ExecutorSignature,
  encodeSignedTx,
  estimateIntrinsicGas,
  executorSigningHash,
  MAX_CALLDATA_BYTES,
  MAX_CALLS,
  rlpInt,
  validateEvTx,
} from './evTx';
export { hmacSignature, l2Headers, type OrderbookCredential } from './hmac';
export {
  type Call,
  encodeKernelSignature,
  KERNEL_TYPES,
  kernelCreateAccountCalldata,
  kernelExecuteCalldata,
  kernelWrapTypedData,
} from './kernel';
export {
  hashOrder,
  ORDER_TYPES,
  type OrderStruct,
  orderDomain,
  orderTypedData,
  toWireOrder,
  type WireOrder,
} from './order';
