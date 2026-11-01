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

Use Node 22 or later, or Bun. The SDK does not run in the browser yet.

Install viem 2.57.7 or later next to the SDK, so both share one copy. `import` and `require` both
work. In TypeScript, set `moduleResolution` to `NodeNext`, `Node16` or `Bundler`.

## Entry points

| Import | What it has |
| --- | --- |
| `@xomarket/client` | The clients, enums, errors and types. |
| `@xomarket/client/viem` | `privateKey` and `signerFrom`, to sign with a key or a viem account. |
| `@xomarket/client/node` | `fileStore`, to keep credentials on disk, and `installShutdownHooks`. |
| `@xomarket/client/signing` | Low-level signing. You rarely need it. |

## Keep your key safe

Keep your key in a `.env` file that git ignores, or in a secrets manager. Never put it in
your code or on the command line, where your shell history keeps it.

<!-- snippet: none -->
```sh
# .env
XO_PK=0x...
```

## Next steps

- [Place your first order](quickstart.md)
- [Read markets and prices](markets.md)
