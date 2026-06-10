---
title: "Production Deployment Guide (superseded)"
version: v3.0.0
updated: 2026-06-09
status: superseded
category: deployment
tags: [deployment, pointer]
---

# Production Deployment Guide — superseded

> **This guide is stale.** It described a manual single-repo SFTP + server-side
> `npm install` process that no longer matches the live two-repo, GitHub
> Actions + `deploy.sh` architecture. It was kept only as historical context and
> has been reduced to a pointer to prevent drift.

## Use these instead
1. **[`BURNRATE_TWO_REPO_DEPLOYMENT_AUDIT.md`](./BURNRATE_TWO_REPO_DEPLOYMENT_AUDIT.md)**
   — canonical source of truth: what the automation actually does, the
   `--delete` race, restart limitations, migrations, supply-chain rules.
2. **[`PRE_DEPLOYMENT_CHECKLIST.md`](./PRE_DEPLOYMENT_CHECKLIST.md)** — the
   human-in-the-loop review gates for an actual deploy.
3. **`scripts/deploy.sh`** and **`scripts/apply-prod-migrations.sh`** (in
   BurnRate-Private) — the executable process.

Connection details live in `ssh-host-config.txt`, not in docs.
