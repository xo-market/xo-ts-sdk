# Contributing

Thank you for using `@xomarket/client`. This page says how to reach us and what a change has to
pass.

## Bug reports, feature requests and questions

Open an issue with one of the [issue forms](https://github.com/xo-market/xo-ts-sdk/issues/new/choose):

- **Bug report**: something does not work as documented. The form asks for the SDK version, your
  Node or Bun version, the smallest code that shows it, what you expected and what happened, and
  the error's `code` and `requestId`.
- **Feature request**: the problem you have, and the API you would like.
- **Question or feedback**: anything else.

Never paste a private key, an API key or a token into an issue. The SDK redacts them from its
errors, but your own logs may not.

The guides and the API reference are at
[docs.xo.market/typescript-sdk/overview](https://docs.xo.market/typescript-sdk/overview).

## Pull requests

We are not accepting external pull requests yet. Open an issue first, so that we can talk about
the change before anyone writes it.

## Working on the SDK

This part is for the maintainers, and for anyone who builds the repository locally.

You need Node 22 or later and [pnpm](https://pnpm.io) 10. The pnpm version is pinned by
`packageManager` in `package.json`; with Corepack enabled, `pnpm` picks it up by itself.

```sh
pnpm install
```

A change must pass these checks, which CI runs on every pull request:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm run docs:check
pnpm -C scripts public-check
```

CI runs more than these five. It also builds the package and checks the build, type-checks the
examples and the code the docs quote (against the built package) and the tooling, runs the
tooling's tests, and runs the runtime smoke test on Node and on Bun. Run them too when your
change touches what they cover:

```sh
pnpm -C packages/client build
pnpm -C packages/client check:package
pnpm --filter "./examples/*" typecheck
pnpm run docs:typecheck
pnpm -C scripts typecheck
pnpm -C scripts test
node scripts/bun-smoke.ts
```

The [README](README.md) explains every command, and [AGENTS.md](AGENTS.md) has the conventions
for the API, the examples and the docs. [SDK_DIRECTION.md](SDK_DIRECTION.md) explains how the API
is named and shaped, and why.

A change that users can see (a new method, a changed behavior, a fix) needs a changeset, which
becomes its entry in the changelog:

```sh
pnpm changeset
```

Commit messages and pull request texts are public. The public-content check reads them, along
with every file, and fails when it finds an internal name.
