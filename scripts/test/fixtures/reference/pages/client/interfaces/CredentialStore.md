# Interface: CredentialStore

Keeps credentials between calls. Everything in a store is a secret (except `mintPause`):
an implementation must never log a value, and no error it throws may contain one.

## Properties

### persistent

```ts
readonly persistent: boolean;
```

`true` when values outlive the process. A session issues longer-lived keys then.

## Methods

### delete()

```ts
delete(key): Promise<void>;
```

Removes a key. A key that is not there is not an error.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

#### Returns

`Promise`\<`void`\>

***

### get()

```ts
get(key): Promise<StoredCredentials | undefined>;
```

The stored value, or `undefined` when there is none or it cannot be used.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |

#### Returns

`Promise`\<`StoredCredentials` \| `undefined`\>

***

### set()

```ts
set(key, value): Promise<void>;
```

Stores `value` under `key`, replacing what was there.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `key` | `string` |
| `value` | `StoredCredentials` |

#### Returns

`Promise`\<`void`\>
