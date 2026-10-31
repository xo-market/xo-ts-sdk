# Type Alias: ApiKey

```ts
type ApiKey = object;
```

An API key of the account, as the account lists it: its metadata, never the key itself. A
key that is revoked or has expired is still listed.

## Properties

### createdAt

```ts
createdAt: string;
```

When the key was made, as an ISO 8601 time.

***

### expiresAt

```ts
expiresAt: string;
```

When the key expires, as an ISO 8601 time.

***

### id

```ts
id: string;
```

The key's id.

***

### lastUsedAt

```ts
lastUsedAt: string | null;
```

When the key was last used, as an ISO 8601 time. `null` when it never was.

***

### name

```ts
name: string;
```

The key's name. A key the SDK signs in for is named `xo-sdk:<label>:<yyyymmdd>`.

***

### prefix

```ts
prefix: string;
```

The first characters of the key, to recognise it.

***

### revokedAt

```ts
revokedAt: string | null;
```

When the key was revoked, as an ISO 8601 time. `null` while it is not.

***

### scopes

```ts
scopes: ("account:read" | "account:write" | string & object)[];
```

What the key may do, such as `account:read`. A scope added later reads as its own string.
