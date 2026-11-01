# XO Market TypeScript SDK

The repository of [`@xomarket/client`](packages/client), the TypeScript SDK of XO Market: sign
in with a wallet key, find markets, quote both sides, stream the book and your own fills, handle
the on-chain steps, and read your Liquidity Rewards. It is built for liquidity providers and
market makers who run a bot on a server (Node 22 or later, or Bun).

The SDK runs on XO **mainnet**, XO's production chain, with real money. If you want to use the
SDK, start with the [package README](packages/client/README.md) and the
[documentation](docs/README.md). The rest of this page is for people who work on the SDK itself.

## Layout

| Path | What it is |
| --- | --- |
| `packages/client/` | `@xomarket/client`, the one published package: `src/`, unit tests in `test/`, live end-to-end tests in `e2e/`. |
| `examples/` | Runnable examples of the package on mainnet: `examples/scripts/`, one short script per task (markets and prices, orders, deposits, a read-only dashboard, a smart wallet), and `examples/mm-bot/`, a demo market-making bot. The scripts read `.env` (copy `.env.example`). Not published to npm. |
| `scripts/` | The SDK's own tooling: the docs checks, the public-content check and the release helpers. Not published to npm. |
| `docs/` | The documentation, as Markdown (`docs/site.json` lists the pages of the TypeScript SDK tab of docs.xo.market). `docs/snippets/` is the code its pages quote, type-checked and never run. `docs/reference/` is generated. |
| `test-vectors/` | Golden JSON vectors (signatures, hashes, encodings) that the signing kit is tested against. |
| `.changeset/` | Pending release notes ([Changesets](https://github.com/changesets/changesets)). |
| `.github/` | `workflows/` (`ci.yml` on every pull request and push to `main`, `dependency-review.yml` on every pull request, `nightly-e2e.yml`, `route-coverage.yml` and `release.yml`), `dependabot.yml` (weekly dependency updates), the issue forms and the pull request template. `CODEOWNERS` names the owners of the workflows and the release configuration. |

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
| `pnpm -C packages/client check:package` | After a build: publint, are-the-types-wrong and a scan of the declarations. |
| `pnpm --filter @xomarket/examples list:markets` | Runs an example; [`examples/scripts/README.md`](examples/scripts/README.md) lists them all. Build first: they use the built package. |
| `pnpm --filter "./examples/*" typecheck` | Type-checks both example packages against the built package, so build first. |
| `pnpm run docs:typecheck` | Type-checks `docs/snippets/`, the code the docs quote, against the built package too. |
| `pnpm -C scripts typecheck` and `pnpm -C scripts test` | The same for the tooling, and its tests. |
| `node scripts/bun-smoke.ts` (or `bun scripts/bun-smoke.ts`) | After a build: the runtime smoke test of the built package (both builds of the four entries, signing, HMAC, one request, one WebSocket subscription, and a prompt exit), with no network. |

`.github/workflows/ci.yml` runs all of these (and the docs checks below) on Node 22 and Node 24,
and the runtime smoke test on Bun.

## Live end-to-end tests

The e2e suite runs against XO mainnet, read-only: the strict contract checks of the public
routes, and the account reads of one fixed wallet. It never places or cancels an order, sends a
transaction or calls a write route; the only writes are signing in and out and the sponsor's
sign-only route, which signs and never broadcasts (the order book's batch reads, a POST that
carries a list of tokens, change nothing and are allowed too). It refuses any other request
before it leaves the process. It is skipped unless you ask for it:

```sh
XO_E2E=1 pnpm -C packages/client test:e2e
```

The signed-in parts need one secret, `XO_E2E_WALLET_PK`: the key of a wallet that holds nothing
and has a public profile. Before each signed-in block the suite checks both, for its EOA and its
smart wallet: no USDC, no position, and a public profile (a private one would hide its positions
from the check, so the suite refuses it). Without the variable those blocks are skipped and the public ones
still run. Export it in your shell (never commit a `.env` file or a key). The nightly workflow
runs the whole suite every night with that secret, and opens an issue when it fails.

## Documentation checks

Every code block of `docs/` is copied from the docs-only code of `docs/snippets/` (type-checked
by `pnpm run docs:typecheck`, never run) or a test, and the API reference is generated from the
source. Two commands keep that true:

```sh
pnpm run docs:build   # regenerates docs/reference/ (typedoc)
pnpm run docs:check   # verifies, writes nothing: reference drift, snippets, error codes, public content, the site build, links
```

`docs:check` fails when a block differs from its source region (`pnpm -C scripts docs-snippets
--write` refreshes the blocks), when `docs/errors.md` and the error codes in
`packages/client/src` differ, when a page of the site (or the npm or examples README) is not
mainnet-only, says "ask the XO team", or links to an out-of-date page of the site, when the
TypeScript SDK tab of docs.xo.market does not build from `docs/` (a page that is not in
`docs/site.json`, one that does not compile as MDX, a dead link between pages;
`pnpm -C scripts docs-site build --out <dir>` writes the tab), or when an internal link is dead.
`pnpm -C scripts docs-public-check` lists each finding of the public-content part. CI runs
`docs:check` after the build.

## The public-content check

This repository is public, and so are the npm package, the commit messages and the pull
requests. The public-content check keeps internal names, tickets and other internal
references out of all of them:

```sh
pnpm -C scripts public-check                       # every tracked file, and the file names
pnpm -C scripts public-check --tarball client.tgz  # every file of an npm tarball
pnpm -C scripts public-check --commits origin/main..HEAD
```

It never prints what it blocks: a finding shows its line with each match replaced by `***`. The
rules are in `scripts/public-rules.ts`. CI runs it on every pull request.

## API compatibility

The SDK follows semantic versioning. On 0.x a minor release may include breaking changes; we aim
to avoid them and to give a deprecation path first. Patch releases do not break, except APIs
marked `@experimental`.

## Releases

Releases are manual, and a push to `main` never publishes anything. In short:

1. Each change users can see gets a changeset: `pnpm changeset`.
2. A maintainer runs `pnpm release:version` on an up-to-date `main`, and squash-merges the pull
   request it opens.
3. A publisher (a login in the `NPM_PUBLISHERS` variable) runs the Release workflow on `main`
   during a release window (`NPM_PUBLISH_ENABLED`), and another required reviewer of
   `npm-release` approves the deployment. It publishes to npm through trusted publishing, then tags the commit
   and creates the GitHub release.

[RELEASING.md](RELEASING.md) has the whole procedure: the one-time setup, every command, how to
check a release, troubleshooting, and who does what.

## Contributing

Bugs, feature requests and questions go through the issue forms; we are not accepting external
pull requests yet. [CONTRIBUTING.md](CONTRIBUTING.md) has the details, and
[AGENTS.md](AGENTS.md) has the conventions for the API, the examples and the docs.

## License

MIT. See [LICENSE](LICENSE).
