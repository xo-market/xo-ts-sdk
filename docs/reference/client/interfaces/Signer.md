# Interface: Signer

Something that signs for a wallet. Implement it to sign with a key the SDK must not hold
(a key management service, a hardware wallet), or make one with `privateKey` or
`signerFrom` from `@xomarket/client/viem`.

The address is asked for with `getAddress()`, so it may come from somewhere that needs a
round trip. The SDK asks once, when the signer is first used. A signer made by this
package holds nothing but functions: a private key stays in a closure, so logging,
`JSON.stringify` or `util.inspect` of it can never show it.

## Methods

### getAddress()

```ts
getAddress(): Promise<`0x${string}`>;
```

The address of the wallet. Any case; the SDK checksums it.

#### Returns

`Promise`\<`` `0x${string}` ``\>

The wallet's `0x` address.

***

### signHash()?

```ts
signHash?(hash): Promise<`0x${string}`>;
```

A signature of a raw 32-byte digest, with no prefix and no hashing. Only a signer that
holds the key itself can do this, so a wallet client (a browser wallet, a hardware
wallet) leaves the property out. Logins, orders and cancels do not need it; on-chain
transactions do, and are refused for a signer without it (`sign_hash_unsupported`).

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `hash` | `` `0x${string}` `` | The 32-byte digest. |

#### Returns

`Promise`\<`` `0x${string}` ``\>

The signature as `0x` hex.

***

### signMessage()

```ts
signMessage(message): Promise<`0x${string}`>;
```

An EIP-191 `personal_sign` signature of a text message.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `message` | `string` | The text to sign. |

#### Returns

`Promise`\<`` `0x${string}` ``\>

The signature as `0x` hex.

***

### signTypedData()

```ts
signTypedData(typedData): Promise<`0x${string}`>;
```

An EIP-712 signature of typed data.

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `typedData` | `MessageDefinition` | The domain, types, primary type and message to sign. |

#### Returns

`Promise`\<`` `0x${string}` ``\>

The signature as `0x` hex.
