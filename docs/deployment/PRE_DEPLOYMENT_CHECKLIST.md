---
title: "Pre-Deployment Checklist (HITL Gates)"
version: v3.1.0
created: 2024-12-24
updated: 2026-10-25
status: current
category: deployment
tags: [deployment, checklist, hitl, two-repo, supply-chain, privacy]
---

# Pre-Deployment Checklist — Human-in-the-Loop Gates

> **Mechanics live in [`BURNRATE_TWO_REPO_DEPLOYMENT_AUDIT.md`](./BURNRATE_TWO_REPO_DEPLOYMENT_AUDIT.md)
> (the canonical source of truth).** This file is the *review layer*: what **you**
> do and what **you** check at each gate. When the two disagree, the audit wins
> on mechanics; update this file to match.

## TL;DR
Test locally → review every changed line → protect the `--delete` race (order +
excludes) → migrate before restart → **do a real DirectAdmin Stop/Start** → verify
on the live site. A green Action + `restart.txt` does **not** mean the site is
serving fresh code.

## Table of Contents
- [Gate 1 — Local first](#gate-1--local-first)
- [Gate 2 — Read the diff](#gate-2--read-the-diff)
- [Gate 3 — CI/CD change?](#gate-3--cicd-change)
- [Gate 4 — New deployable file? (the --delete trap)](#gate-4--new-deployable-file-the---delete-trap)
- [Gate 5 — Migrations](#gate-5--migrations)
- [Gate 6 — Commit on a branch](#gate-6--commit-on-a-branch)
- [Gate 7 — Deploy via the script](#gate-7--deploy-via-the-script)
- [Gate 8 — Watch the order](#gate-8--watch-the-order)
- [Gate 9 — Migrate on the server](#gate-9--migrate-on-the-server)
- [Gate 10 — Real restart + verify](#gate-10--real-restart--verify)
- [Supply-chain rules](#supply-chain-rules-always)
- [Rollback](#rollback)

---

## Gate 1 — Local first
Run the app locally; confirm the change works in the real UI.
- [ ] **Your check:** Have I *seen* it work locally? If not, stop.

## Gate 2 — Read the diff
- [ ] **Your check:** Can I explain every changed line? Any secret/key/PII in the
  code? Any scope creep? If a line is unclear, make it be explained — don't pass it.

## Gate 3 — CI/CD change?
- [ ] **Your check:** Does this touch a workflow / `deploy.yml` / `deploy.sh`?
  If yes → **explicit approval required** before it lands (standing rule).

## Gate 4 — New deployable file? (the `--delete` trap)
RealFeygon deploys with `rsync --delete` and **wipes anything not in its repo**.
- [ ] **Your check:** Did this add a BurnRate-Private file that ships to prod?
  If yes, is it covered by RealFeygon's exclude list? If not, RealFeygon's deploy
  deletes it → 404s. A new exclude is a CI change → back to Gate 3.
- [ ] **Your check (privacy):** Is any private content meant to reach the server?
  It goes in `views/nickerson/` (login-protected, never served as static files),
  **never** in `docs/`. The server's `docs/` is public at `/docs`, and
  BurnRate-Private's `docs/` is excluded from deploy for that reason.
- [ ] **Your check:** If either exclude list changed, was the rsync replay re-run?
  See "How the exclude lists were verified" in the audit.

## Gate 5 — Migrations
- [ ] **Your check:** New DB columns/tables? If yes, the migration must run on the
  server **before** the restart (see Gate 9). Confirm the `.sql` exists.

## Gate 6 — Commit on a branch
- [ ] **Your check:** One logical change per commit? Message accurate? Never commit
  straight to `main` on RealFeygon — merging to `main` *is* the deploy trigger.

## Gate 7 — Deploy via the script
Run `cd D:/Repos/BurnRate-Private && bash scripts/deploy.sh` (it enforces order,
waits for both Actions, touches the restart marker).
- [ ] **Your check:** Am I about to type `git push origin main` by hand? **Stop** —
  use the script. Hand-pushing is what caused the race 404s.

## Gate 8 — Watch the order
- [ ] **Your check:** Did **RealFeygon's** Action finish *before* BurnRate-Private
  deploys? RealFeygon last = it deletes the private overlay.

## Gate 9 — Migrate on the server
If Gate 5 applied: `bash scripts/apply-prod-migrations.sh` (applies server SQL in
order). Note: it continues on error, so a failure can hide — read its output.
- [ ] **Your check:** Did the new columns land **before** the new code runs?

## Gate 10 — Real restart + verify
**`touch tmp/restart.txt` is NOT a reliable restart.** To actually serve fresh
code/templates/DB state, **Stop then Start the Node app in DirectAdmin** — required
after template/route changes, DB replacement, or migrations.
- [ ] **Your check:** Did I do a real DirectAdmin Stop/Start?
- [ ] **Your check:** Does the **live page** show the change? Any 404s on Nickerson
  JS/CSS (the tell-tale of the race)?

---

## Supply-chain rules (ALWAYS)
The deploy pipeline is the attack surface. Non-negotiable:
- Third-party GitHub Actions are **pinned to a commit SHA**, never a tag.
- Workflow token is **least-privilege** (`permissions: contents: read`).
- **No `npm install` / build scripts in any job that holds deploy secrets.**
- Before adding ANY dependency: run the **secure-installer** skill; honor the
  7-day release-age rule. See the supply-chain section of the audit.

## Rollback
If the live site is broken: identify the last-good commit, revert, redeploy via
the script, and do a real DirectAdmin Stop/Start. Connection details are in
`ssh-host-config.txt` (not duplicated here).
