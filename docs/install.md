# Installation

<!-- code-group -->
<!-- snippet: none -->
```sh npm
npm install @xomarket/client viem
```

<!-- snippet: none -->
```sh pnpm
pnpm add @xomarket/client viem
```

<!-- snippet: none -->
```sh yarn
yarn add @xomarket/client viem
```

<!-- snippet: none -->
```sh bun
bun add @xomarket/client viem
```

The SDK runs on a server with Node 22 or later, or Bun. It does not run in the browser yet.

## Requirements

- **viem 2.57.7 or later.** Install it next to the SDK so your project and the SDK share one copy.
- **TypeScript.** Set `moduleResolution` to `NodeNext`, `Node16` or `Bundler`.
- **ESM or CommonJS.** Both `import` and `require` work.

## Entry points

| Import | What it has |
| --- | --- |
| `@xomarket/client` | `createPublicClient`, `createSecureClient`, the enums, the errors and the types. Nothing in it needs Node. |
| `@xomarket/client/viem` | `privateKey` and `signerFrom`, the signers for a private key or a viem account. |
| `@xomarket/client/node` | `fileStore`, to keep credentials on disk, and `installShutdownHooks`. |
| `@xomarket/client/signing` | Low-level order and login signing. You rarely need it. |

## Keep your key safe

Load your private key from a `.env` file that git ignores, or from a secrets manager. Never put
it in your code or on the command line, where your shell history keeps it. The SDK never prints
a key, not even in an error.

<!-- snippet: none -->
```sh
# .env
XO_PK=0x...
```
