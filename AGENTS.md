# Conventions for this repository

`@xomarket/client` is the TypeScript SDK of XO Market. This file is for coding agents and for
people: it states the rules of the project. Read it before you change anything, and keep a
change inside them.

## Layout

| Path | What it holds |
| --- | --- |
| `packages/client/` | The published package. `src/` is the code, `test/` the unit tests (no network), `e2e/` the live tests. |
| `examples/` | Runnable examples, not published: `examples/scripts/` (`@xomarket/examples`) holds one short script per task, `examples/mm-bot/` (`@xomarket/mm-bot`) a demo market-making bot. |
| `docs/` | The documentation as Markdown. `docs/snippets/` is the code its pages quote; `docs/reference/` is generated, never edited by hand. |
| `scripts/` | The tooling: the docs checks, the public-content check and the release helpers. Not published. |
| `test-vectors/` | Golden JSON vectors (signatures, hashes, encodings) that the signing code is tested against. |

## Commands

Run them from the repository root. A change has to pass all of them.

```sh
pnpm install
pnpm lint                         # Biome; `pnpm format` fixes the formatting
pnpm typecheck
pnpm test
pnpm run docs:check               # `pnpm run docs:build` refreshes docs/reference/ first
pnpm -C scripts public-check
pnpm changeset                    # for every change that users can see
```

Those are the checks everyone runs. CI runs more, so run these too when a change touches what they
cover (the build first, since the examples and the smoke test use the built package):

```sh
pnpm -C packages/client build
pnpm -C packages/client check:package   # publint, are-the-types-wrong, a scan of the declarations
pnpm --filter "./examples/*" typecheck  # both example packages
pnpm run docs:typecheck                 # the docs-only code of docs/snippets/
pnpm -C scripts typecheck
pnpm -C scripts test
node scripts/bun-smoke.ts               # CI also runs it on Bun
```

Node 22 or later and pnpm 10. Commit messages are short and start with a type, as in
`fix: stop a list on a repeated page`.

## The shape of the public API

The same rules, with the reasons behind them, are in [SDK_DIRECTION.md](SDK_DIRECTION.md). Keep the
two in step.

- **Build the API around what the developer wants to do**, never around which backend service
  answers. A developer asks for markets, a book or an order; the services behind them do not
  show. The shapes of the services are translated once, at the boundary, and their raw schemas
  stay internal.
- **A method's prefix says what it does.**

  | Prefix | What the method does |
  | --- | --- |
  | `list*` | Reads a long list and returns a paginated result. |
  | `fetch*` | Reads one item, or one plain collection. |
  | `create*` | Signs an order and does not send it. |
  | `post*` | Sends orders that are already signed. |
  | `place*` | Signs and sends. |
  | `cancel*` | Cancels. |
  | `setup*` | Does a one-time setup. |
  | `waitFor*` | Polls until the thing reaches a final state. |

  On-chain actions are named for the action: `mergePositions`, `redeemPositions`,
  `transferErc20`.

- **One request object, or none.** Reads then take an optional trailing `options`
  (`{ signal, timeout, retries }`). Mutations take no options and are never retried; a send is
  never re-signed either. When the outcome of a send is uncertain, the error says
  `mayHaveLanded: true` and carries the id to check.
- **Names.** Everything is camelCase. An identifier ends in `Id`. An outcome token is an `assetId`
  in a request and `outcomes.yes.tokenId` on the market model. A set of strings is a TypeScript
  enum (`OrderSide`, `OrderType`). "No value" is `null`.
- **Types.** An input accepts plain values (strings, numbers, booleans). An output carries
  branded types, and an amount is a decimal string in whole units (`'1.5'` is one and a half
  USDC).
- **TSDoc.** A public method's comment says what it does for the developer and never names a
  backend service. Every public method has `@throws` naming the errors it can throw and one
  `@example` that has no imports.

## Docs and examples

- **Code in the docs is never typed by hand.** Every code block of a page in `docs/` is copied
  from compiled code: the docs-only code of `docs/snippets/` (one file per page, type-checked by
  `pnpm run docs:typecheck` against the built package, never run) or a test. Mark the block with
  `<!-- snippet: docs/snippets/<file>.ts#<region> -->` on the line above it, and wrap the code in
  the source file in `// #region <region>` and `// #endregion`. A short shell or JSON block that
  has no source takes `<!-- snippet: none -->`. `pnpm -C scripts docs-snippets --write` refreshes
  the blocks, and `pnpm run docs:check` fails when one differs from its source. The docs never
  quote the runnable examples.
- **Examples do one task each.** One short file in `examples/scripts/src/`, one job, run with
  `pnpm --filter @xomarket/examples <noun:verb>` (a script of its `package.json`, listed in its
  README). No header and no `// #region` markers: a comment only for a step that is not obvious.
  Local imports have no extension (`./lib/env`); the shared helpers in `src/lib/` stay tiny. An
  example runs against the built package, as a user's code would, and its settings come from the
  `.env` at the repository root (`.env.example`).

## What never goes in this repository

This repository, the npm package, the commit messages and the pull requests are public. The
public-content check (`pnpm -C scripts public-check`) fails on:

- the name of any other SDK or company's product, in code, docs, comments, commits or pull
  requests; describe our own design in our own words;
- an internal name, a ticket id or a reference to an internal document;
- an attribution to an assistant, in a file, a commit message or a pull request.

A key, a token or an address of a funded wallet never goes in a file either. Live tests and
examples read them from the environment.
