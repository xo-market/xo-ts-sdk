# Interface: XoErrorOptions

Options every error accepts. All of them are optional.

## Properties

### cause?

```ts
optional cause?: unknown;
```

The underlying error. Passed through the standard ES2022 `Error` options.

***

### code?

```ts
optional code?: string;
```

A stable, machine-readable code. Each class has its own default.

***

### requestId?

```ts
optional requestId?: string;
```

The server's correlation id for the request, when it sent one.

***

### service?

```ts
optional service?: Service;
```

Which service raised the error. Defaults to `'sdk'` (raised locally).

***

### status?

```ts
optional status?: number;
```

The HTTP status, when the error came from an HTTP response.
