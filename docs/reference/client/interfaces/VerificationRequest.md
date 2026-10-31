# Interface: VerificationRequest

One thing the bridge asks the owner wallet to sign, decoded so the caller can look at it before
anything is signed. It is what a [VerifyCallback](../type-aliases/VerifyCallback.md) receives, and the SDK signs exactly
`decoded` if the callback approves it. The object is frozen all the way down: changing it
changes nothing that is signed.

## Properties

### decoded

```ts
decoded: 
  | {
  kind: "eip712";
  typedData: MessageDefinition;
}
  | {
  kind: "eip191";
  message: string;
};
```

What will be signed, parsed: the typed data of an EIP-712 payload (`signTypedData`), or the
text of an EIP-191 payload (`signMessage`).

***

### payload

```ts
payload: string;
```

What the bridge sent, as it sent it.

***

### paymentId

```ts
paymentId: string;
```

The payment the signature is for.

***

### reason

```ts
reason: "EVM_OWNER" | "EVM_WITHDRAWAL";
```

What the signature is for: `'EVM_OWNER'` or `'EVM_WITHDRAWAL'`. An item with any other reason is refused before the callback is asked.

***

### signatureType

```ts
signatureType: "EIP712" | "EIP191";
```

How `payload` is signed: `'EIP712'` (typed data) or `'EIP191'` (a message).
