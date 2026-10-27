# BurnRate Two-Repo Deployment Audit

**Status:** Verified against scripts, workflows, configs, symlinks, and recent deploy behavior  
**Verified:** 2026-10-25 (exclude lists and privacy boundary re-verified by rsync replay)
**Scope:** Public BurnRate demo in `RealFeygon` and private Nickerson/BurnRate app in `BurnRate-Private`

## TL;DR

- Deploy with `bash scripts/deploy.sh` (in BurnRate-Private): RealFeygon first, BurnRate-Private second.
- RealFeygon uses `rsync --delete`; every private file that ships must be covered by a RealFeygon exclude.
- BurnRate-Private's `docs/` never deploys, because the server's `docs/` is public. Private runtime content goes in `views/nickerson/`.
- A green Action plus `touch tmp/restart.txt` is not a restart. Do a DirectAdmin Stop/Start.

## Contents

- [Deployment Topology](#deployment-topology)
- [Current Automation: What Actually Happens](#current-automation-what-actually-happens)
- [Privacy Boundary: What May Ship to the Server](#privacy-boundary-what-may-ship-to-the-server)
- [Fragile Parts](#fragile-parts)
- [Pitfalls Introduced By Those Automations](#pitfalls-introduced-by-those-automations)
- [Manual Steps That Still Matter](#manual-steps-that-still-matter)
- [Supply-Chain & CI Security](#supply-chain--ci-security)
- [Revision History](#revision-history)

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
2. Checks out code on `ubuntu-latest` (`actions/checkout` pinned to a commit SHA)
3. Fails the run if a tracked symlink sits in a deployable (non-excluded) path
4. Sets up SSH keys in the runner
5. Cleans stale server-side `node_modules.backup-*` directories
6. Deploys via `rsync -avz --delete`
7. Removes any `.env` file on the server
8. Touches `tmp/restart.txt`

There is no `npm install` step (removed 2026-06-10; see the supply-chain section).

Important exclusions in the public deploy. An excluded path is also **protected
from `--delete`**, which is how the private overlay survives a RealFeygon deploy:

- `data`
- `views/nickerson` (includes the private wiki content in `views/nickerson/reports/`)
- `views/layouts/nickerson.handlebars`
- `dbcon_nickerson.js`
- `Nickerson.js`
- `scripts/NickersonCallbacks.js`
- `config/nickersonWikiReports.js` (added 2026-10-25; `Nickerson.js` requires it at load)
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
- `/docs` — **privacy-critical**; see [Privacy Boundary](#privacy-boundary-what-may-ship-to-the-server)
- `/CLAUDE.md`, `/.claude`, `/todo`, `/tasks`, `/coverage`, `/archive`, `/openspec`, `/tests` — dev-only

The leading `/` anchors a pattern to the repo root, so `/docs` cannot match a
same-named folder deeper in the tree.

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

## Privacy Boundary: What May Ship to the Server

**Rule: BurnRate-Private's `docs/` folder never deploys.**

Why: `documentation.js` serves the server's entire `docs/` folder as static
files at `/docs`, with no authentication, and lists root-level docs in the
portal. Both repos deploy into the same server folder, so anything the private
repo ships into `docs/` becomes public. Private files that share a name with a
public file are worse: the private copy overwrites the public one, and the
public BurnRate demo then renders it.

Where private content belongs:

| Kind of private content | Location in BurnRate-Private | Deployed? | Reachable how |
|---|---|---|---|
| Runtime wiki reports (`.md`, `.png`, tracker `.csv`) | `views/nickerson/reports/` | Yes | Only via the login-protected `/Nickerson/wiki` routes |
| Planning notes, PRDs, reviews, research | `docs/` | **No** | Local only |
| Task records, specs, coverage, agent config | `todo/`, `tasks/`, `openspec/`, `coverage/`, `.claude/` | No | Local only |

`views/nickerson/` is the right home for private runtime content because:

- RealFeygon already excludes it, so `--delete` never removes it
- nothing serves it as static files
- local dev reaches it through the existing `views/nickerson` symlink

**Incident (found 2026-10-25):** before this rule, every correct-order deploy
shipped about 90 private files into the public `docs/` tree, and the private
wiki reports overwrote the public demo's same-named reports. The exposure lasted
from each BurnRate-Private deploy until the next RealFeygon deploy removed the
files. Files left on the server from earlier deploys under `.claude/`,
`openspec/` and `tests/` are protected by RealFeygon's excludes, so they need a
one-time manual removal. None of them are served over HTTP.

### How the exclude lists were verified

The fix was tested by replaying both deploys with real rsync (3.2.7, the
version on `ubuntu-latest`) into an empty folder, using the `--exclude` flags
parsed directly from each workflow file. Three orders were replayed: correct
order, race (RealFeygon last), and recovery (BurnRate-Private re-run). For each,
the replay asserts:

1. every file under `docs/` is byte-identical to RealFeygon's own copy
2. `config/nickersonWikiReports.js` is present
3. `views/nickerson/reports/` holds all wiki reports
4. no dev-only private folders are present

The old workflows failed checks 1–4; the fixed workflows pass all of them in
all three orders. Re-run this replay whenever either exclude list changes.

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

- neither workflow runs `npm install` (RealFeygon's CI install was removed 2026-06-10)
- production deploy does **not** run `npm install` on the server
- `package-lock.json` is excluded from deploy
- `BurnRate-Private` excludes both `package.json` and `package-lock.json`

Implication:

- adding a new runtime dependency to `RealFeygon` requires a real server-side dependency refresh if DirectAdmin does not automatically reinstall packages
- a green Action says nothing about whether the production Node app has the new dependency

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

## Existing Documentation: Status

- `DEPLOYMENT_GUIDE.md` and `CI_CD_SETUP.md` were reduced to pointers on 2026-06-09. Their old content was stale.
- `PRE_DEPLOYMENT_CHECKLIST.md` was rewritten on 2026-06-09 as the human review gates, and updated on 2026-10-25 for the privacy boundary.

### `scripts/deploy.sh`

Operationally useful, but still limited:

- assumes its final SSH verification is authoritative
- touches `tmp/restart.txt` but cannot perform the manual DirectAdmin Stop/Start
- waits on `gh run list --limit 1` five seconds after pushing; if GitHub has not registered the new run yet, it can read the previous run's result

### `scripts/apply-prod-migrations.sh`

Its wording is now accurate: it says it applies all SQL files and does not track applied state. The behavior is still fragile:

- it re-runs every server-side SQL file and continues after errors, so a real failure looks the same as an already-applied migration

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

Use this precedence order:

1. Current GitHub Actions workflow files
2. Current `scripts/deploy.sh` and `scripts/apply-prod-migrations.sh`
3. `ssh-host-config.txt` and `.vscode/sftp.json`
4. This audit document
5. `PRE_DEPLOYMENT_CHECKLIST.md` for the review gates

## Open Follow-Ups

- Make the migration script track applied migrations instead of re-running everything.
- Make `deploy.sh` wait for the run belonging to the pushed commit, not the latest run.
- Shared files present in both repos (`views/helpers/helpers.js`, `config/wikiReports.js`, `views/partials/scenario-card.handlebars`) have drifted apart. BurnRate-Private's copy wins on the server after a correct-order deploy; RealFeygon's copy wins after a race.

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

## Revision History

- **2026-10-25** — Added the Privacy Boundary section and the rsync replay method. Updated both exclude lists (BurnRate-Private now excludes `/docs` and dev-only folders; RealFeygon now excludes `config/nickersonWikiReports.js`). Corrected stale claims about `npm install` in CI and about the superseded docs.
- **2026-06-09/10** — Supply-chain hardening; superseded docs reduced to pointers.
- **2026-05-10** — First verified audit.
