# XO Market TypeScript SDK

The repository of [`@xomarket/client`](packages/client), the TypeScript SDK of XO Market. It is
built for liquidity providers and market makers who run a bot on a server (Node 22 or later, or
Bun).

## Layout

| Path | What it is |
| --- | --- |
| `packages/client/` | `@xomarket/client`, the one published package: `src/`, and its unit tests in `test/`. |
| `examples/` | Runnable examples of the package. |
| `scripts/` | The SDK's own tooling. |

## Set up

You need Node 22 or later and [pnpm](https://pnpm.io). The pnpm version is pinned by
`packageManager` in `package.json`; with Corepack enabled, `pnpm` picks it up by itself.

```sh
pnpm install
```

## Everyday commands

Run them from the repository root.

| Command | What it does |
| --- | --- |
| `pnpm lint` | Biome: lint and format check of the whole repository. `pnpm format` fixes the formatting. |
| `pnpm typecheck` | Type-checks the package. |
| `pnpm test` | The unit tests of the package (no network). |
| `pnpm build` | Builds `packages/client/dist` (ESM, CommonJS and types). |

## License

MIT. See [LICENSE](LICENSE).
