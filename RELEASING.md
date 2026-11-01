# Releasing `@xomarket/client`

How a new version of the SDK gets from `main` to npm: the one-time setup, every step with its
command, how to check the result, and what to do when something goes wrong. It is for the
people who maintain this repository; SDK users never need it.

Nothing is ever published by accident. A push to `main` only reports what is pending, and
publishing is a manual run of the Release workflow by a named person, during a release window
that is opened just for it.

## At a glance

| Step | Who | What |
| --- | --- | --- |
| 1 | anyone, in a PR | Add a changeset to each change users can see: `pnpm changeset` |
| 2 | a maintainer | On an up-to-date `main`: `pnpm release:version` (opens the release PR) |
| 3 | a maintainer | Squash-merge the release PR |
| 4 | a repository admin | Open the release window: `NPM_PUBLISH_ENABLED=true` |
| 5 | **a publisher** | Run the Release workflow on `main` with the new version; **another required reviewer of `npm-release`** approves it |
| 6 | a repository admin | Close the release window: delete `NPM_PUBLISH_ENABLED` |
| 7 | a maintainer; at 0.5.0 also a publisher (npm write access, two-factor) | Check npm, the tag and the GitHub release; install it once; at 0.5.0, the publisher deprecates the pre-releases |
| 8 | a maintainer | Publish the docs: `DOCS_REPO=<owner/name> pnpm docs:publish` (opens the docs-site PR) |

## Who does what

- **Contributor:** writes the change and its changeset (step 1). Needs nothing special.
- **Maintainer:** can merge pull requests. Runs `pnpm release:version`, merges the release PR,
  and checks the result (steps 2, 3, 7). Needs Node 22 or later, pnpm and the GitHub CLI (`gh`)
  logged in.
- **Repository admin:** sets the repository variables, the `npm-release` environment and the
  repository settings (steps 4, 6 and the setup below).
- **Publisher:** a GitHub login listed in the repository variable `NPM_PUBLISHERS`. Only a run
  that a publisher starts can publish (step 5): the workflow checks who started it, and the run
  has to be started from a publisher's own account. `NPM_PUBLISHERS` may hold a single login.
- **Approver:** a required reviewer of the `npm-release` environment who did **not** start the
  run. "Prevent self-review" is ticked, so the person who starts a run can never approve it, even
  when they are a reviewer themselves: the reviewers must include someone else. With
  `@WalidOfNow` and `@xo-chef-plankton` as the two reviewers, each approves the release the
  other starts.
- **npm org admin:** an admin or owner of the npm organization `xomarket`. Sets the trusted
  publisher and the publishing access of the package on npmjs.com (setup only).

## One-time setup

Set this up once for `xo-market/xo-ts-sdk`. Check it after moving or renaming the repository,
the workflow file or the environment, and when a new person starts publishing.

### npm

- **The package is `@xomarket/client`**, in the npm organization **`xomarket`**. There is no
  `xo-market` organization on npm (the GitHub organization is `xo-market`): a publish under
  `@xo-market/` fails with "Scope not found".
- **Trusted publisher** (npmjs.com → the package → Settings → Trusted publishing → GitHub
  Actions). Every field is exact and case-sensitive, and npm validates nothing when you save:

  | Field | Value |
  | --- | --- |
  | Organization or user | `xo-market` |
  | Repository | `xo-ts-sdk` |
  | Workflow filename | `release.yml` |
  | Environment | `npm-release` |
  | Allowed actions | `npm publish` (and `npm stage publish`) |

  The workflow uses `npm publish`; with only `npm stage publish` allowed, it fails.
- **A new or edited trusted publisher waits for validation:** npm marks it "Pending validation"
  until a publish from the workflow uses it, and drops it if none does within about two days.
  Add or change it shortly before a release, not weeks ahead.
- **Publishing access** (same Settings page): "Require two-factor authentication and disallow
  tokens". Trusted publishing keeps working, and nobody can publish with a stray npm token.
- There is no npm token anywhere: the workflow proves who it is with a short-lived OIDC token.

### GitHub (repository `xo-market/xo-ts-sdk`)

- **Environment `npm-release`** (Settings → Environments):
  - its deployment branches set to `main` only. The trusted publisher names it, so a copy of the
    workflow run from another branch cannot publish;
  - **required reviewers**: at least two people, with **"Prevent self-review"** ticked. A release
    run waits until a reviewer other than the person who started it approves it. A list that
    holds only the person who dispatches would leave every run waiting: add the other approver
    (`@WalidOfNow` and `@xo-chef-plankton` approve each other's releases).

  Create it before the first release: GitHub creates a missing environment, with no protection,
  on first use.
- **Variable `NPM_PUBLISHERS`**: a JSON array of the GitHub logins allowed to start a release,
  such as `["some-login"]`; one login is enough. Anything that is not a JSON array means nobody.

  ```bash
  gh variable set NPM_PUBLISHERS --repo xo-market/xo-ts-sdk --body '["some-login"]'
  ```

- **Variable `NPM_PUBLISH_ENABLED`**: not set. It exists only during a release window (steps 4
  and 6).
- **Pull requests:** squash merging only (Settings → General → Pull Requests), so each change is
  one commit on `main`.
- **Code owners:** `.github/CODEOWNERS` names the publishers as the owners of `.github/`, the
  Changesets config and `scripts/release-version.ts`. A ruleset on `main` that requires Code Owner
  review makes their approval necessary for any change to the release machinery.
- **The backend route check** (`.github/workflows/route-coverage.yml`) is off until the
  repository variable `ROUTE_CHECK_ENABLED` is `true`. It then reads the backend's route registry
  from the location in three repository secrets, with a fourth as its token:
  `ROUTE_REGISTRY_REPO` (`owner/name`), `ROUTE_REGISTRY_PATH` (the file),
  `ROUTE_REGISTRY_TOKEN` (read access to that repository), and optionally `ROUTE_REGISTRY_REF`
  (a branch, tag or commit; `main` when it is not set). They are secrets so that the logs of
  this public repository never show where the registry is. A missing secret fails the run and
  names it.
- **Organization rules** (set by the `xo-market` organization, not this repository): every change
  to `main` goes through a pull request, no branch can be force-pushed, and GitHub Actions may
  not open pull requests. That last rule is why step 2 is a command a maintainer runs, not a bot.
- `packages/client/package.json` must have a `license` field (MIT, with `LICENSE` in the
  repository root). The workflow refuses to publish without one.

### Your machine (maintainers)

- Node 22 or later and pnpm (the version in `packageManager`), then `pnpm install` once.
- The GitHub CLI, logged in with an account that can push branches here: `gh auth status`.

## Step by step

### 1. Add a changeset to each change users can see

In the pull request of the change:

```bash
pnpm changeset
```

Pick `@xomarket/client` and the bump. While the version is 0.x, a fix is `patch` and a new
feature or a breaking change is `minor`. Write the summary for SDK users: it becomes their
changelog entry. It lands as a small file in `.changeset/`.

Changes users cannot see (tests, CI, internal docs) need no changeset. Until a release, each run
of the Release workflow on `main` lists the pending changesets in its summary and changes nothing.

### 2. Prepare the release

On `main`, up to date with `origin`, with a clean tree. First look, then do it:

```bash
pnpm release:version --dry-run
```

```bash
pnpm release:version
```

The dry run prints the new version, the files that change and the text of the pull request,
then puts the tree back. The real run does the same `changeset version` (new version in
`packages/client/package.json`, new entry in `packages/client/CHANGELOG.md`, the changesets
consumed), commits it on a new branch `release/<version>`, pushes it, opens the pull request
and switches back to `main`. It checks everything before it changes anything; see
[Troubleshooting](#troubleshooting) for what each refusal means.

### 3. Merge the release PR

Check that it changes only those three kinds of files and that CI is green, then squash-merge
it. **Merging publishes nothing.** The Release run on `main` that follows says, in its summary,
that the new version is ready to publish.

### 4. Open the release window

```bash
gh variable set NPM_PUBLISH_ENABLED --repo xo-market/xo-ts-sdk --body true
```

(Or Settings → Secrets and variables → Actions → Variables → New repository variable.)

### 5. Run the release (a publisher)

From the publisher's own account, with the version from step 2:

```bash
gh workflow run release.yml --repo xo-market/xo-ts-sdk --ref main -f publish-version=0.5.0
```

Or on GitHub: Actions → **Release** → **Run workflow** → branch `main`, `publish-version` set to
the version → **Run workflow**.

Another reviewer of `npm-release` then approves it: the run page → **Review deployments** →
`npm-release` → **Approve and deploy**. Whoever started the run cannot approve it (Prevent
self-review).

Then follow it on the Actions page, or from the terminal (it ends when the run does):

```bash
gh run watch --repo xo-market/xo-ts-sdk --exit-status $(gh run list --repo xo-market/xo-ts-sdk --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

What the run does, in order:

1. **Select mode** decides there is a version to publish.
2. **Build and pack** checks who started the run, the version and the license, then builds,
   tests and packs the package. It checks that the tarball holds only `dist/`, `README.md`,
   `LICENSE` and `package.json`, and records its sha256.
3. **Publish to npm** waits for the approval of a reviewer who did not start the run, then
   uploads exactly that tarball, through the trusted publisher. Its log ends with
   `Successfully published: @xomarket/client@<version>`.
4. **Tag and release** creates the tag `@xomarket/client@<version>` on the published commit, and
   the GitHub release with the changelog entry.

### 6. Close the release window

As soon as the run is over, whether it worked or not:

```bash
gh variable delete NPM_PUBLISH_ENABLED --repo xo-market/xo-ts-sdk
```

### 7. Check the release

npm takes a few minutes to show a new version: "Your package is being processed and may take a
few minutes to become available". Then:

```bash
npm view @xomarket/client version dist-tags --json
```

`latest` should be the new version. The tag and the release:

```bash
gh release list --repo xo-market/xo-ts-sdk --limit 3
```

Once per release, install it the way a user does, in an empty folder:

```bash
npm init -y && npm pkg set type=module && npm install @xomarket/client@latest
```

```bash
node -e "import('@xomarket/client').then(async ({ createPublicClient }) => { const page = await createPublicClient().listMarkets({ pageSize: 3 }).firstPage(); console.log('markets:', page.items.length); })"
```

It should print `markets: 3`: the package loads, and it reads public data from mainnet with no
key. It only reads: no key, no sign-in, nothing sent.

**At 0.5.0, the first public release, only:** deprecate every earlier version, once, so that
nobody installs a pre-release by mistake. A publisher does it, with npm write access to the
package and logged in to npm with two-factor authentication:

```bash
npm deprecate @xomarket/client@"<0.5.0" "Pre-release: use 0.5.0 or later"
npm deprecate @xomarket/client@0.0.0-stage "Pre-release: use 0.5.0 or later"
```

The range skips a version with a pre-release tag, so `0.0.0-stage` has its own command.
`npm view @xomarket/client versions` still lists them; `npm install @xomarket/client@0.4.0`
then warns with that message.

### 8. Publish the docs

The "TypeScript SDK" tab of docs.xo.market is built from `docs/` and lives in the docs-site
repository, branch `external-prod-only` (what is live). Publishing the docs is a pull request
there, opened by a command; nothing goes live until someone merges it. Run it from this
repository, on the commit that was released (`main` after the release PR), with a clean tree,
`gh` logged in, and the docs-site repository in the environment variable **`DOCS_REPO`**, as
`owner/name`. `DOCS_REPO` is required: without it the command stops at once (exit code 2), names
the variable, and changes nothing. First look, then do it:

```bash
DOCS_REPO=<owner/name> pnpm docs:publish --dry-run
```

```bash
DOCS_REPO=<owner/name> pnpm docs:publish
```

The dry run clones the docs repo into a temporary folder, builds the pages, writes them to
`typescript-sdk/` and the tab to `docs.json`, runs Mintlify's `validate` (the whole site) and
`broken-links` (our pages only, anchors included) on the result, prints the diff stat and the
identity it would commit as (`Will commit as <name> <email>`), and stops: nothing is committed or
pushed, and it prints where the clone is. The real run does the same, then commits on the branch
`sdk-docs/<version>` (the version of `packages/client/package.json`), pushes it, and opens the
pull request into `external-prod-only`. If that branch exists already, it adds a commit to it and
prints the open pull request instead of opening another; it never force-pushes. Add `--draft` to
open the pull request as a draft, and `--docs-repo <dir>` to use a clean clone of your own instead
of a new one.

It changes nothing in the docs repo but the SDK tab of `docs.json` and the `typescript-sdk/`
folder, and stops if anything else would change: it writes `docs.json` back whole, so it first
checks that the file is formatted as it writes it, and refuses to reformat it. Review the pull
request (Mintlify builds a preview), and **do not merge it before `xo-market/xo-ts-sdk` is
public**: the pages link to files in it. The version of the Mintlify CLI is `MINT_VERSION` in
[`scripts/docs-publish.ts`](scripts/docs-publish.ts), at least 14 days old when it was set; raise
it by hand when Mintlify's checks change.

| Message | What to do |
| --- | --- |
| `DOCS_REPO is not set` | Set it to the docs-site repository, `owner/name`, and run again. Nothing was changed. |
| `DOCS_REPO is "...", not a repository (owner/name)` | Give it as `owner/name`, without the host or a path. Nothing was changed. |
| `The docs repo's origin is "...", not <owner/name>` | The clone given by `--docs-repo` is not a clone of `DOCS_REPO`: use one that is, or fix `DOCS_REPO`. |
| `The working tree has changes` | Commit or stash them: the pages are built from the tree. |
| `git config user.email is empty` | Set it; the docs commit is made as you. |
| `The GitHub CLI is not logged in` | `gh auth login` |
| `docs.json in the docs repo is not formatted as this script writes it` | The docs repo now formats `docs.json` another way than the script writes it (2 spaces, a final newline), so publishing would reformat the whole file. Nothing was changed. Make `formatDocsJson` in `scripts/docs-publish.ts` write the new format (its test round-trips a copy of the real file, `scripts/test/fixtures/docs-json/docs.json`: refresh it), then run again. |
| `Files outside docs.json and typescript-sdk/ would change` | The docs repo changed in a way the script does not handle. Nothing was committed; look at the files it lists in the clone it names. |
| `mint validate` or `mint broken-links` fails | The pages or `docs.json` are wrong: Mintlify's output names the page and the link. Fix the source under `docs/` and run again. The clone it names has the result. |
| `Nothing to publish` | The branch already has these pages. |
| `... is pushed: open the pull request by hand` | The branch is on origin; run the `gh pr create` command it prints. |

## Troubleshooting

### `pnpm release:version` refuses

It changed nothing; fix the cause and run it again.

| Message | What to do |
| --- | --- |
| `You are on "<branch>": switch to main` | `git switch main` |
| `The working tree has changes` | Commit or stash them. |
| `main is not the same commit as origin/main` | `git pull` (or push what is yours). |
| `No changeset is pending` | There is nothing to release: add a changeset (step 1). |
| `The GitHub CLI is not logged in` | `gh auth login` |
| `The branch release/<version> already exists` | That release is already prepared: find its PR, or delete the stale branch. |
| `changeset version changed files it should not have` | Look at the files it lists. It undid its own changes. |
| `... opening the pull request failed` | The commit is on the local branch it names. Push it or open the PR with the command it prints. |

### The run skips "Build and pack" and "Publish to npm"

A gate is closed. Nothing was published. Check each one:

- `NPM_PUBLISH_ENABLED` is `true` (step 4).
- The run was started by a login in `NPM_PUBLISHERS`, on `main`.
- The Select mode summary shows mode `publish`. Mode `version` means changesets are still
  pending: the release PR is not merged yet. Mode `none` means the version is already on npm:
  there is nothing to publish, and npm never takes the same version twice.
- A run that waits behind a push to `main` can be cancelled by a later push. Start it again.

### "Publish to npm" shows Waiting

It waits for the approval of a required reviewer of `npm-release` who did not start the run
(step 5). Nothing is published until then. If no one else can approve it, the environment's
reviewers hold only the person who started the run: a repository admin adds the other approver
(see [the setup](#github-repository-xo-marketxo-ts-sdk)), then the waiting run can be approved.

### A step of the run fails

| Error | Meaning |
| --- | --- |
| `Not a publisher` | The person who started the run is not in `NPM_PUBLISHERS`, or the variable is not a JSON array. |
| `Wrong version` | `publish-version` differs from `packages/client/package.json`. Run it again with the right one. |
| `Placeholder version` | The package is at 0.0.0: no release PR was merged. |
| `No license` | `packages/client/package.json` has no `license` field. |
| `Unexpected files in the tarball` | Something besides `dist/`, the README, the license and `package.json` would ship. Fix `files` in `package.json`. |
| `Tarball changed` | The tarball that would be uploaded is not the one that was checked. Nothing was published; start the run again. |
| npm 404 / 403 / OIDC error in "Publish to npm" | npm did not trust the run. Check the trusted publisher fields against the [setup](#npm), and that it has not lapsed (re-add it, then publish within two days). |
| `Scope not found` | The package name is not in an npm organization you can publish to. The scope is `@xomarket/`. |
| "Tag and release" failed | The package is published. Re-run only that job (the run page → Re-run failed jobs): it does not publish again, and it skips the tag or release if they already exist. |

### Other things you may see

- **npm does not show the new version right after the run.** It is still being processed. Wait
  a few minutes; the first releases took two to eight minutes.
- **`0.0.0-stage` in `npm view @xomarket/client versions`.** npm created it when the package was
  first published (staged publishing). It is never `latest` and changes nothing for users. Step 7
  deprecates it, with the other pre-releases, at 0.5.0.
- **"GitHub Actions is not permitted to create or approve pull requests".** That is the
  organization's rule; it is why step 2 is `pnpm release:version`.
- **"push declined due to repository rule violations".** The organization does not allow direct
  pushes or force-pushes to `main`. Use a pull request.
- **A broken version is on npm.** npm never lets a version be replaced. Fix it in a new patch
  release, and mark the broken one: `npm deprecate @xomarket/client@<version> "<why, and which version to use>"`.
  `npm unpublish` works only within 72 hours and breaks anyone who installed it; avoid it.

## Notes

- **The trust boundary.** The checks in `release.yml` (who publishes, the release window, the
  version, the license) bind only people who cannot change `release.yml` on `main`. Changes to
  `main` go through pull requests: anyone who can merge to `main` without a review could edit
  the workflow and drop them. So require a Code Owner review on `main`: `.github/CODEOWNERS`
  names the publishers for `.github/`, the Changesets config, the versioning script and the files
  of the public-content check. The approval of another required reviewer of `npm-release` holds on
  top of that.
- **Provenance.** This repository is public, so the trusted publisher attaches provenance to
  every release by itself.
- **History.** 0.5.0 is the first public release. The versions before it were pre-releases;
  deprecating them is part of the 0.5.0 release (step 7).
- **How the workflow works**, job by job and gate by gate, is in the header of
  [`.github/workflows/release.yml`](.github/workflows/release.yml). The release command is
  [`scripts/release-version.ts`](scripts/release-version.ts).
