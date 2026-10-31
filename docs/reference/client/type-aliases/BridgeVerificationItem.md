# Type Alias: BridgeVerificationItem

```ts
type BridgeVerificationItem = object;
```

One thing the bridge asks the owner wallet to sign before the payment goes on.

## Properties

### payload

```ts
payload: string;
```

What the owner wallet signs, as the bridge sent it.

***

### reason

```ts
reason: "EVM_OWNER" | "EVM_WITHDRAWAL" | string & object;
```

What the signature is for: `EVM_OWNER` or `EVM_WITHDRAWAL`. A reason added later reads as its own string.

***

### signatureType

```ts
signatureType: "EIP712" | "EIP191" | string & object;
```

How `payload` is signed: `EIP712` (typed data) or `EIP191` (a message).
