## What and why

<!-- What does this change, and why is it needed? -->

## Checks run

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm run docs:check`
- [ ] `pnpm -C scripts public-check`

CI also runs the build and `check:package`, the type checks of the examples, the docs code and
the tooling, the tooling's tests and the Bun smoke test (`node scripts/bun-smoke.ts`). Run them too
when your change touches what they cover.

## Changeset

Added (`pnpm changeset`): yes / no. A change that users cannot see needs none.
