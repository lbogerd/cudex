# Pre-coworker verification walkthrough

Use this checklist on the reviewed pilot branch before asking a coworker to
install or run Cudex. Run it yourself on a Linux/x86_64 machine with Docker and
access to the pilot CubeSandbox service and shared release directory.

Do not use a real project. The live checks intentionally modify a disposable
Git checkout and allocate billable CubeSandbox resources. Never paste API keys,
Codex authentication, connection URLs, or private keys into a prompt, terminal
transcript, issue, or this document.

If any expected result is missing, stop, run `cudex status` and `cudex cleanup`
if a run was allocated, and record the failure in `TODO.md`. Do not work around
a failed safety or cleanup assertion.

## 1. Confirm the candidate commit

From the repository root:

```bash
git switch cudex/coworker-pilot
git status --short --branch
git rev-list --left-right --count origin/cudex/coworker-pilot...HEAD
git diff --check
node --version
git --version
docker version
uname -s
uname -m
```

Check all of the following:

- [ ] The working tree is clean.
- [ ] The revision count is `0 0`, so the candidate is neither ahead of nor
      behind the pushed review branch.
- [ ] Node.js is version 22 or newer.
- [ ] The platform is `Linux` and `x86_64`.
- [ ] Git and Docker are available without an interactive privilege prompt.

If this machine uses passwordless Docker through sudo, use `sudo -n docker` in
the Docker commands below.

## 2. Run the local automated gates

```bash
npm run build --prefix e2b
node --test e2b/dist/test/shortcut-registry.test.js
npm test --prefix e2b
```

- [ ] The build succeeds.
- [ ] The shortcut-registry test succeeds.
- [ ] The complete default test run has no failures. PostgreSQL-gated skips are
      expected in this first run.

Now run the PostgreSQL-gated tests against one disposable database:

```bash
VERIFY_PG_CONTAINER="cudex-pre-coworker-postgres-$$"
docker run --detach --name "$VERIFY_PG_CONTAINER" \
  --env POSTGRES_PASSWORD=cudex_verification_only \
  --env POSTGRES_DB=cudex_verification \
  --publish 127.0.0.1::5432 postgres:17-alpine
until docker exec "$VERIFY_PG_CONTAINER" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
VERIFY_PG_PORT="$(docker port "$VERIFY_PG_CONTAINER" 5432/tcp | awk -F: 'END { print $NF }')"
HOSTED_AGENT_TEST_DATABASE_URL="postgres://postgres:cudex_verification_only@127.0.0.1:${VERIFY_PG_PORT}/cudex_verification" \
  npm test --prefix e2b
docker rm --force "$VERIFY_PG_CONTAINER"
unset VERIFY_PG_CONTAINER VERIFY_PG_PORT
```

Regardless of whether the test command succeeds, remove the exact disposable
container before continuing.

- [ ] The complete database-backed suite has no failures.
- [ ] Only the explicitly environment-gated Docker test is skipped.
- [ ] The disposable PostgreSQL container is gone.

Run that final Docker/Compose integration test:

```bash
POC_DOCKER_TEST=true node --test --test-concurrency=1 \
  e2b/dist/test/poc-infrastructure.test.js
docker ps --all --filter name=cudex
docker volume ls --filter name=cudex
```

- [ ] The infrastructure test succeeds.
- [ ] No container or volume created by these checks remains. Investigate any
      listed pre-existing Cudex resource rather than deleting it by name alone.

## 3. Verify the published release

Set this to the exact read-only manifest that the coworker will receive:

```bash
read -r -p "Shared release.json path: " CUDEX_RELEASE
CUDEX_RELEASE="$(realpath "$CUDEX_RELEASE")"
node e2b/scripts/verify-cudex-release.mjs \
  "$CUDEX_RELEASE" "$(git rev-parse HEAD)"
./e2b/scripts/install-cudex.sh --release "$CUDEX_RELEASE"
export PATH="$HOME/.local/bin:$PATH"
cudex setup --release "$CUDEX_RELEASE"
cudex version
cudex doctor --verify-template
```

Enter the LAN API URL and API key only at the hidden setup prompts. If Codex
authentication is not found, run `cudex login`, complete device login, and run
the doctor again.

- [ ] Release checksum, size, executable-mode, platform, and revision checks
      succeed.
- [ ] `cudex version` reports the intended Cudex and Codex revisions.
- [ ] `cudex doctor --verify-template` reports `ready: true` and
      `templateVerified: true`.
- [ ] The release ID and checksums are recorded in `ARCHIVE.md` without secrets.

## 4. Create and inspect a disposable checkout

```bash
VERIFY_PROJECT="$(mktemp -d /tmp/cudex-pre-coworker.XXXXXX)"
git -C "$VERIFY_PROJECT" init --quiet
git -C "$VERIFY_PROJECT" config user.name "Cudex Verification"
git -C "$VERIFY_PROJECT" config user.email "cudex-verification@example.invalid"
printf 'baseline\n' > "$VERIFY_PROJECT/notes.txt"
printf 'conflict baseline\n' > "$VERIFY_PROJECT/conflict.txt"
printf 'ignored.txt\n' > "$VERIFY_PROJECT/.gitignore"
printf 'must stay local\n' > "$VERIFY_PROJECT/ignored.txt"
git -C "$VERIFY_PROJECT" add .gitignore conflict.txt notes.txt
git -C "$VERIFY_PROJECT" commit --quiet -m baseline
printf 'non-ignored untracked\n' > "$VERIFY_PROJECT/untracked.txt"
cudex files -C "$VERIFY_PROJECT"
```

- [ ] The file list contains `.gitignore`, `conflict.txt`, `notes.txt`, and
      `untracked.txt`.
- [ ] It does not contain `.git`, `ignored.txt`, or files outside the disposable
      checkout.
- [ ] The original checkout remains unstaged and uncommitted.

Keep `VERIFY_PROJECT` set for the remaining steps.

## 5. Verify successful automatic return

```bash
cudex -C "$VERIFY_PROJECT" \
  "Append exactly hosted-success on its own line to notes.txt. Create returned.txt containing exactly returned-from-cudex plus a newline. Do not change any other file."
VERIFY_EXIT=$?
git -C "$VERIFY_PROJECT" status --short
git -C "$VERIFY_PROJECT" diff
git -C "$VERIFY_PROJECT" diff --cached --quiet
cat "$VERIFY_PROJECT/notes.txt" "$VERIFY_PROJECT/returned.txt"
printf 'exit=%s ignored=%s\n' "$VERIFY_EXIT" "$(cat "$VERIFY_PROJECT/ignored.txt")"
cudex status
```

- [ ] Cudex exits `0` after the TUI closes.
- [ ] `notes.txt` and `returned.txt` contain the requested hosted changes.
- [ ] `git diff` shows the changes, while `git diff --cached --quiet` succeeds.
- [ ] `ignored.txt` still says `must stay local`.
- [ ] `cudex status` reports `active: false`.
- [ ] No Cudex Docker resources remain.

Commit the verified changes only inside this disposable fixture so the next
test has a clear baseline:

```bash
git -C "$VERIFY_PROJECT" add notes.txt returned.txt untracked.txt
git -C "$VERIFY_PROJECT" commit --quiet -m successful-return
```

## 6. Verify conflict safety

Open two terminals. In terminal A, start a run whose hosted edit is delayed:

```bash
cudex -C "$VERIFY_PROJECT" \
  "Run sleep 20 first. Then replace conflict.txt with exactly hosted value plus a newline. Do not change any other file."
VERIFY_CONFLICT_EXIT=$?
printf 'exit=%s value=%s\n' "$VERIFY_CONFLICT_EXIT" "$(cat "$VERIFY_PROJECT/conflict.txt")"
git -C "$VERIFY_PROJECT" status --short
cudex status
```

As soon as the TUI is working, use terminal B to make a concurrent local edit:

```bash
printf 'local concurrent value\n' > "$VERIFY_PROJECT/conflict.txt"
```

Return to terminal A and let the hosted task and TUI finish.

- [ ] Cudex exits `4`.
- [ ] `conflict.txt` still contains `local concurrent value`; the hosted value
      was not partially applied.
- [ ] No unrelated checkout path changed.
- [ ] `cudex status` reports `active: false`, and no Cudex Docker resources
      remain.

## 7. Verify interruption and exact cleanup

First restore only the disposable conflict file:

```bash
git -C "$VERIFY_PROJECT" restore conflict.txt
cudex -C "$VERIFY_PROJECT" \
  "Run sleep 300 before making any workspace change."
```

Once the TUI is active, press Ctrl-C. If Codex handles the first Ctrl-C without
exiting, press it once more and wait for Cudex cleanup.

```bash
printf 'exit=%s\n' "$?"
cudex status
cudex cleanup
docker ps --all --filter name=cudex
docker volume ls --filter name=cudex
git -C "$VERIFY_PROJECT" status --short
```

- [ ] The interrupted command returns `130` after cleanup.
- [ ] `cudex status` reports no active run.
- [ ] `cudex cleanup` is idempotent and reports a clean state.
- [ ] No run-owned container, volume, sandbox, snapshot, lease, or ticket
      remains.
- [ ] The checkout has no new change from the interrupted run.

## 8. Run the root/child live proof

This is a maintainer diagnostic, not part of the coworker workflow. Configure
the ignored `e2b/poc/.env` as described in `e2b/poc/README.md`, using the same
reviewed artifacts and template, then run:

```bash
./e2b/scripts/hosted-codex-poc.sh preflight
./e2b/scripts/hosted-codex-poc.sh automated
```

- [ ] The automated proof reaches `HOSTED_CODEX_POC_OK` and exits `0`.
- [ ] The child is isolated, its durable patch is applied by the root, and the
      fixture verification succeeds.
- [ ] Status and cleanup prove that exact provider and Docker resources are
      gone.

If the automated proof is interrupted or returns nonzero, inspect and clean up
the retained exact run before doing anything else:

```bash
./e2b/scripts/hosted-codex-poc.sh status
./e2b/scripts/hosted-codex-poc.sh down
```

Root-sandbox loss, child-sandbox loss, and an infinite child command require an
authorized CubeSandbox fault-injection mechanism. Do not improvise by listing
or deleting shared provider resources. Run the approved fault-injection cases
for the exact run identity, record only redacted outcomes in `ARCHIVE.md`, and
leave H3 open in `TODO.md` until all three clean up exactly. If there is no
approved way to select the exact sandbox, that is a release blocker—not a test
to delegate to the coworker.

## 9. Review retained output and make the decision

Inspect the redacted reports named by the completed runs and the current
repository diff. Do not copy runtime credentials or ignored state into Git.

```bash
git status --short
git diff --check
git ls-files | grep -E '(^|/)(\.env|auth\.json|runtime\.env|compose\.env)$|\.(key|pem)$' || true
```

- [ ] Reports and logs contain no API keys, auth JSON, tokens, tickets,
      connection URLs, database credentials, private keys, or project content.
- [ ] `README.md`, `TODO.md`, `ARCHIVE.md`, and active `PILOT-nnn` comments agree.
- [ ] H1 through H3 evidence is complete and redacted in `ARCHIVE.md`.
- [ ] Every failure found above has a `TODO.md` entry.
- [ ] The candidate branch remains clean, reviewed, and pushed.

Only after every applicable box passes should a coworker follow the shorter
fresh-install workflow in `README.md`. Keep this disposable checkout until the
coworker instructions have been compared against it, then remove only the exact
directory printed in `VERIFY_PROJECT`.
