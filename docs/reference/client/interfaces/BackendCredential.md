# Interface: BackendCredential

The `xo_sk_data_...` bearer key a SIWE login returns.

## Properties

### expiresAt

```ts
expiresAt: string;
```

ISO-8601 time. The store never reads it: the session decides when a key is stale.

***

### id

```ts
id: string;
```

The key's id on the backend.

***

### key

```ts
key: string;
```

The secret bearer key itself.

***

### prefix

```ts
prefix: string;
```

The non-secret start of `key`, which the backend lists.

***

### scopes

```ts
scopes: string[];
```
