# BurnRate Two-Repo Deployment Audit

**Status:** Verified against scripts, workflows, configs, symlinks, and recent deploy behavior  
**Verified:** 2026-05-10
**Scope:** Public BurnRate demo in `RealFeygon` and private Nickerson/BurnRate app in `BurnRate-Private`

## Purpose

This document is the verified deployment audit for the current two-repo BurnRate architecture.

It is not a generic deployment guide. It records:

- what the deployment automation actually does today
- which parts are fragile
- which parts are manual despite appearing automated
- which existing docs are stale or only partially true
- which pitfalls repeatedly cause drift or false confidence

## Verified Sources Reviewed

### RealFeygon

- [docs/deployment/DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md)
- [docs/deployment/PRE_DEPLOYMENT_CHECKLIST.md](./PRE_DEPLOYMENT_CHECKLIST.md)
- [docs/deployment/CI_CD_SETUP.md](./CI_CD_SETUP.md)
- [.github/workflows/deploy.yml](D:/Repos/RealFeygon/.github/workflows/deploy.yml)
- [.vscode/sftp.json](D:/Repos/RealFeygon/.vscode/sftp.json)
- [ssh-host-config.txt](D:/Repos/RealFeygon/ssh-host-config.txt)

### BurnRate-Private

- [scripts/deploy.sh](D:/Repos/BurnRate-Private/scripts/deploy.sh)
- [scripts/apply-prod-migrations.sh](D:/Repos/BurnRate-Private/scripts/apply-prod-migrations.sh)
- [.github/workflows/deploy.yml](D:/Repos/BurnRate-Private/.github/workflows/deploy.yml)
- [docs/flowchart-agentic-sdlc.md](D:/Repos/BurnRate-Private/docs/flowchart-agentic-sdlc.md)
- [docs/ledger-refactor/MORNING-REPORT.md](D:/Repos/BurnRate-Private/docs/ledger-refactor/MORNING-REPORT.md)

## Deployment Topology

The current BurnRate deployment is a **two-repo layered deploy**:

1. `RealFeygon` deploys first.
2. `BurnRate-Private` deploys second.

This order is mandatory because:

- `RealFeygon` deploy uses `rsync --delete`
- `BurnRate-Private` deploy is additive and overlays private/shared files on top

If the order is reversed, the `RealFeygon` deploy can delete files that the private overlay depends on.

## Current Automation: What Actually Happens

### RealFeygon GitHub Action

Verified from `.github/workflows/deploy.yml`:

1. Runs on push to `main`
2. Checks out code on `ubuntu-latest`
3. Runs `npm install` in CI
4. Sets up SSH keys in the runner
5. Cleans stale server-side `node_modules.backup-*` directories
6. Deploys via `rsync -avz --delete`
7. Removes any `.env` file on the server
8. Touches `tmp/restart.txt`

Important exclusions in the public deploy:

- `data`
- `views/nickerson`
- `views/layouts/nickerson.handlebars`
- `dbcon_nickerson.js`
- `Nickerson.js`
- `scripts/NickersonCallbacks.js`
- many Nickerson/private JS/CSS files
- `package-lock.json`

### BurnRate-Private GitHub Action

Verified from `.github/workflows/deploy.yml`:

1. Runs on push to `main`
2. Checks out code on `ubuntu-latest`
3. Sets up SSH keys in the runner
4. Deploys via additive `rsync -avz`
5. Touches `tmp/restart.txt`

Important exclusions in the private deploy:

- `data`
- `package.json`
- `package-lock.json`

### BurnRate-Private `scripts/deploy.sh`

Verified behavior:

1. Requires both repos to be on `main`
2. Refuses to proceed if tracked changes are uncommitted
3. Pushes `RealFeygon` first
4. Waits for the latest `RealFeygon` GitHub Action to complete
5. Pushes `BurnRate-Private` second
6. Waits for the latest `BurnRate-Private` GitHub Action to complete
7. Attempts post-deploy SSH checks
8. Touches `tmp/restart.txt`

## Fragile Parts

### 1. `tmp/restart.txt` is not a real restart

This is the single most important operational fact.

`touch tmp/restart.txt` does **not** immediately restart the DirectAdmin Node app in a reliable way for this stack.

What it actually does:

- may signal the app supervisor
- may be enough for some file reload behaviors
- is often **not** enough to pick up template, route, or SQLite state changes immediately

What reliably refreshes the app:

1. Stop the Node app in DirectAdmin
2. Start the Node app again

This is especially important after:

- DB file replacement
- route/template changes that seem stale after deploy
- migration runs

### 2. SQLite sidecars can preserve stale state

Relevant files:

- `*.db`
- `*.db-wal`
- `*.db-shm`

If a SQLite DB file is replaced on disk but the app does not cleanly reopen it, stale state may persist.

Verified guidance:

- do **not** delete `.wal` / `.shm` while the app is running
- if a DB file was replaced and behavior still looks stale:
  1. stop the app
  2. replace the `.db` file
  3. remove matching `.db-wal` and `.db-shm`
  4. start the app

This is not required for every restart. It is only needed when DB freshness is in doubt after a DB replacement.

### 2a. Startup cleanup is now implemented in the DB connectors

Verified current code paths:

- `dbcon_burnrate.js`
- `dbcon_nickerson.js`

Both now call a shared helper before opening SQLite:

- `scripts/sqlite-sidecar-cleanup.js`

What it does:

- checks for `<db>.db-wal` and `<db>.db-shm`
- compares their mtimes to the main `.db`
- removes the sidecars only when the main `.db` is newer than every existing sidecar

Why this helps:

- catches the common “DB file replaced but stale sidecars remain” case automatically at startup
- reduces the need for manual `.wal` / `.shm` cleanup after deploy

What it does **not** do:

- it does not force a real app restart
- it does not delete sidecars blindly on every startup
- it does not replace the need for a DirectAdmin stop/start when the app is stale

Remaining pitfall:

- if the process never truly restarts, this startup cleanup will never run
- so `tmp/restart.txt` still cannot be treated as a reliable DB refresh mechanism by itself

### 3. Shared symlinked directories create cross-repo drift risk

Verified locally:

- `D:\Repos\RealFeygon\views\nickerson` -> `D:\Repos\BurnRate-Private\views\nickerson`
- `D:\Repos\RealFeygon\data` -> `D:\Repos\BurnRate-Private\data`

Implications:

- local file inspection in `RealFeygon` can be misleading because some paths are actually private-repo content
- shared view behavior can change BurnRate and Nickerson simultaneously
- older private DB lineage can appear to exist on the public side through the symlinked `data` tree

This is a major source of confusion during debugging and RCA.

### 4. Public and private DB lineages are different

Verified:

- `data/burnrate_v5.db` is the older shared/private lineage
- `burnrate_data/burnrate_demo.db` is the public BurnRate demo lineage

They are not interchangeable.

This means:

- scenario/report drift is not always a DB problem
- report inventory drift comes from files/config/templates, not scenario DB rows
- seeing `burnrate_v5.db` on the public side does not mean the public BurnRate route is supposed to use it

### 5. The deploy script’s post-deploy wording can overstate completion

Verified current state:

- `scripts/deploy.sh` now uses `D:\Repos\RealFeygon\ssh-host-config.txt`
- `scripts/apply-prod-migrations.sh` now uses `D:\Repos\RealFeygon\ssh-host-config.txt`
- `scripts/deploy.sh` now labels the final marker step as `Touching restart marker`, not a true app restart

The old SSH-config-path failure mode has been repaired.
The old script wording that implied a full DirectAdmin restart has also been repaired.

### 6. Package installation is only partially automated

Verified:

- `RealFeygon` CI runs `npm install` in GitHub Actions
- production deploy does **not** run `npm install` on the server
- `package-lock.json` is excluded from deploy
- `BurnRate-Private` excludes both `package.json` and `package-lock.json`

Implication:

- adding a new runtime dependency to `RealFeygon` may still require a real server-side dependency refresh if DirectAdmin does not automatically reinstall packages
- successful CI install does **not** guarantee the production Node app has the new dependency

This already caused a real issue with `marked`.

### 7. `rsync --delete` is both necessary and dangerous

`RealFeygon` deploy uses `--delete`.

Benefits:

- removes stale public files
- makes public deploy deterministic

Risks:

- will remove files not represented in the public repo
- can break the combined app unless the private overlay is reapplied afterward
- can fail if server-side leftover directories resist deletion

This already caused a real GitHub Actions failure on stale `node_modules.backup-*` directories.

That is why the workflow now includes a pre-rsync cleanup step for those backup directories.

## Automated Parts That Help

### RealFeygon workflow hardening already in place

Verified current mitigations:

- pre-rsync cleanup of `node_modules.backup-*`
- `ssh-keyscan ... || true`
- `StrictHostKeyChecking=no`
- `UserKnownHostsFile=/dev/null`

These make deploys more robust against transient SSH/bootstrap failures.

### BurnRate-Private workflow hardening already in place

Same SSH hardening pattern is now present there too.

## Pitfalls Introduced By Those Automations

### 1. Host authenticity is no longer strongly enforced in CI deploys

Because the workflows now use:

- `StrictHostKeyChecking=no`
- `UserKnownHostsFile=/dev/null`

the deploys are more reliable, but less strict about host verification.

That is an operational tradeoff, not a free win.

### 2. `ssh-keyscan ... || true` can hide setup fragility

It prevents early failure, which is useful.
It also means a broken host-key-scan step no longer blocks the workflow, so later SSH/rsync failures become the real signal.

### 3. `deploy.sh` gives a false sense of full completion

The script can:

- successfully push both repos
- watch both GitHub Actions succeed
- touch `tmp/restart.txt`
- and still leave the running DirectAdmin process serving stale code or DB state until a real Stop/Start occurs

So “deploy script completed” does **not** automatically mean “DirectAdmin is serving the fresh build.”

## Manual Steps That Still Matter

### Reliable deployment sequence

Verified safe sequence:

1. Ensure intended commits exist in `RealFeygon/main`
2. Ensure intended commits exist in `BurnRate-Private/main`
3. Push `RealFeygon` first
4. Wait for its GitHub Action to succeed
5. Push `BurnRate-Private` second
6. Wait for its GitHub Action to succeed
7. If a DB changed and stale data is suspected:
   - stop DirectAdmin app
   - replace DB
   - delete matching `.wal` / `.shm`
   - start DirectAdmin app
8. Otherwise, still prefer a real DirectAdmin stop/start if the site appears stale after deploy

### Migrations

Verified from `scripts/apply-prod-migrations.sh`:

- it applies all server-side SQL files in order with `sqlite3`
- it tolerates errors and continues
- it touches `tmp/restart.txt`
- it explicitly warns that you must still manually stop/start the app in DirectAdmin

Fragility:

- the script says "pending migrations" but applies all server-side SQL files in order
- “continue on error” can hide real migration failures by treating already-applied migrations and broken migrations the same way

## Existing Documentation: What Is Stale

### `docs/deployment/DEPLOYMENT_GUIDE.md`

Mostly stale for BurnRate two-repo reality.

Still describes:

- manual SFTP upload as the primary method
- generic single-repo app deployment
- server-side `npm install` as the normal post-upload step

Missing:

- two-repo layering
- `RealFeygon` first / `BurnRate-Private` second
- `rsync --delete` race condition
- DirectAdmin restart limitations
- SQLite sidecar refresh caveat

### `docs/deployment/PRE_DEPLOYMENT_CHECKLIST.md`

Useful as a generic hygiene checklist, but stale for BurnRate deploy specifics.

Missing:

- two-repo order
- shared symlink realities
- post-deploy stale-state handling
- distinction between `data/burnrate_v5.db` and `burnrate_data/burnrate_demo.db`

### `docs/deployment/CI_CD_SETUP.md`

Stale for the current live setup.

Specific mismatches:

- documents SSH host/port assumptions that do not reflect the current SFTP/SSH config
- documents server-side install/restart assumptions more cleanly than the current DirectAdmin behavior actually provides
- does not capture the hardened SSH options now in the live workflows

### `scripts/deploy.sh`

Operationally useful, but still limited:

- assumes its final SSH verification is authoritative
- touches `tmp/restart.txt` but cannot perform the manual DirectAdmin Stop/Start

### `scripts/apply-prod-migrations.sh`

Closer to reality than the older docs because it explicitly warns that `restart.txt` does not restart Node.

Still misleading in one important way:

- says "pending migrations" but applies all server-side SQL files and continues after errors

## Connection Details (not stored here)

> **Redacted on purpose.** This `docs/` tree is served publicly by
> `documentation.js` at realfeygon.com, so host/port/username/key path must not
> live in it. The literal values live only in local, untracked config:
>
> - `.vscode/sftp.json` (SFTP host/port/user/remote path) — gitignored
> - `ssh-host-config.txt` (SSH host alias + key path) — local only
>
> Manual SSH uses the host-config file:
>
> ```powershell
> ssh -F "<path-to>/ssh-host-config.txt" <host-alias>
> ```

## Recommended Operational Source of Truth

Until the older docs are rewritten, use this precedence order:

1. Current GitHub Actions workflow files
2. Current `scripts/deploy.sh` and `scripts/apply-prod-migrations.sh`
3. `ssh-host-config.txt` and `.vscode/sftp.json`
4. This audit document
5. Older deployment guides only as historical context

## Immediate Documentation Follow-Ups Recommended

1. Rewrite `docs/deployment/DEPLOYMENT_GUIDE.md` around the two-repo BurnRate architecture
2. Rewrite `docs/deployment/PRE_DEPLOYMENT_CHECKLIST.md` to include:
   - repo order
   - DB refresh rules
   - DirectAdmin stop/start requirement
3. Rewrite `docs/deployment/CI_CD_SETUP.md` to match the current workflows instead of the older template
4. Replace the migration script's "pending migrations" behavior or make it track applied migrations explicitly

## Supply-Chain & CI Security

The CI/CD pipeline is the attack surface, not just the delivery mechanism. The
2026 attack wave (tj-actions, actions-cool/issues-helper, trivy-action, TanStack,
CISA "Megalodon") targeted Actions workflows and package installs to harvest
CI/CD secrets. Standing rules now enforced in these repos:

1. **Pin third-party Actions to a commit SHA, never a tag.** A tag can be moved
   to an imposter commit (the dominant technique); a SHA cannot. Both repos pin
   `actions/checkout` to a SHA.
2. **Least-privilege token.** Both workflows set `permissions: contents: read`.
3. **No `npm install` / build scripts in a job that holds deploy secrets.**
   RealFeygon's `npm install` step was removed: it ran arbitrary dependency
   lifecycle scripts in the same job that loads `SSH_PRIVATE_KEY`. The built
   `node_modules` was never deployed (excluded from rsync; DirectAdmin manages
   server modules; no tests ran). See the `marked` note in §6 — CI install never
   guaranteed the prod app had the dependency anyway.
4. **`secure-installer` before adding any dependency**, and honor the 7-day
   release-age rule (do not adopt a version published < 7 days ago). This is the
   harness-enforced "no package managers willy nilly" rule.
5. **No secrets/infra in `docs/`.** This `docs/` tree is *published publicly* by
   `documentation.js` (the `/documentation` portal serves the `deployment`
   category). So the control is **redaction, not exclusion** — host/port/user/key
   paths live only in untracked local config (`.vscode/sftp.json`,
   `ssh-host-config.txt`), never in a doc. (Excluding `docs/` from rsync would
   break the live portal, so that is NOT done.)

Open remediation items are tracked in
`BurnRate-Private/docs/development/SECURITY-DEPENDENCY-REMEDIATION-PLAN.md`
(the `npm audit fix` set, the `better-sqlite3` downgrade guard, and the
unfixable `xlsx`/SheetJS decision). The install-time procedure lives in the
`secure-installer` skill.

## Bottom Line

The current deployment stack is **partly automated, but not fully self-healing**.

What is reliable:

- pushing `RealFeygon` first
- pushing `BurnRate-Private` second
- waiting for both GitHub Actions

What is still manual:

- recognizing stale runtime state
- doing a real DirectAdmin stop/start
- handling DB file refresh edge cases
- treating the script’s final SSH verification failure as a separate issue from the deploy itself

The most dangerous misconception is this:

> A successful GitHub Action plus `touch tmp/restart.txt` does not guarantee the live Node process is actually serving the newly deployed templates or DB files.

That gap is the source of many of the “deployment hell” symptoms observed in this project.
