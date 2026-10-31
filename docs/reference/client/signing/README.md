# @xomarket/client/signing

`@xomarket/client/signing`: the pure signing kit, for advanced use. Every function builds or
hashes locally (orders, cancels, the orderbook's L1 and L2 headers, Kernel wrapping, EvNode
transactions) and does no I/O.

## Interfaces

- [Call](interfaces/Call.md)
- [ClobAuthParams](interfaces/ClobAuthParams.md)
- [EvAccessListItem](interfaces/EvAccessListItem.md)
- [EvCall](interfaces/EvCall.md)
- [EvTx](interfaces/EvTx.md)
- [ExecutorSignature](interfaces/ExecutorSignature.md)

## Variables

- [CANCEL\_ALL\_TYPES](variables/CANCEL_ALL_TYPES.md)
- [CANCEL\_ORDER\_TYPES](variables/CANCEL_ORDER_TYPES.md)
- [CLOB\_AUTH\_MESSAGE](variables/CLOB_AUTH_MESSAGE.md)
- [CLOB\_AUTH\_TYPES](variables/CLOB_AUTH_TYPES.md)
- [EVNODE\_TX\_TYPE](variables/EVNODE_TX_TYPE.md)
- [KERNEL\_TYPES](variables/KERNEL_TYPES.md)
- [MAX\_CALLDATA\_BYTES](variables/MAX_CALLDATA_BYTES.md)
- [MAX\_CALLS](variables/MAX_CALLS.md)
- [ORDER\_TYPES](variables/ORDER_TYPES.md)

## Functions

- [cancelAllTypedData](functions/cancelAllTypedData.md)
- [cancelOrderTypedData](functions/cancelOrderTypedData.md)
- [clobAuthTypedData](functions/clobAuthTypedData.md)
- [encodeKernelSignature](functions/encodeKernelSignature.md)
- [encodeSignedTx](functions/encodeSignedTx.md)
- [estimateIntrinsicGas](functions/estimateIntrinsicGas.md)
- [executorSigningHash](functions/executorSigningHash.md)
- [hashOrder](functions/hashOrder.md)
- [hmacSignature](functions/hmacSignature.md)
- [kernelCreateAccountCalldata](functions/kernelCreateAccountCalldata.md)
- [kernelExecuteCalldata](functions/kernelExecuteCalldata.md)
- [kernelWrapTypedData](functions/kernelWrapTypedData.md)
- [l1Headers](functions/l1Headers.md)
- [l2Headers](functions/l2Headers.md)
- [orderDomain](functions/orderDomain.md)
- [orderTypedData](functions/orderTypedData.md)
- [rlpInt](functions/rlpInt.md)
- [toWireOrder](functions/toWireOrder.md)
- [validateEvTx](functions/validateEvTx.md)

## References

### OrderbookCredential

Re-exports [OrderbookCredential](../interfaces/OrderbookCredential.md)

***

### OrderHash

Re-exports [OrderHash](../type-aliases/OrderHash.md)

***

### OrderStruct

Re-exports [OrderStruct](../interfaces/OrderStruct.md)

***

### WireOrder

Re-exports [WireOrder](../interfaces/WireOrder.md)
