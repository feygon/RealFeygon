---
title: "CI/CD Setup (superseded)"
version: v3.0.0
updated: 2026-06-09
status: superseded
category: deployment
tags: [deployment, ci-cd, pointer]
---

# CI/CD Setup — superseded

> **This document is stale.** It documented SSH host/port and server-side
> install/restart assumptions that no longer match the live workflows (which now
> use SHA-pinned actions, least-privilege tokens, and hardened SSH options). It
> has been reduced to a pointer to prevent drift.

## Use these instead
- **Live workflow files** — `.github/workflows/deploy.yml` in each repo (the
  authoritative CI/CD definition).
- **[`BURNRATE_TWO_REPO_DEPLOYMENT_AUDIT.md`](./BURNRATE_TWO_REPO_DEPLOYMENT_AUDIT.md)**
  — verified description of what the workflows do, plus the supply-chain section.
- **[`PRE_DEPLOYMENT_CHECKLIST.md`](./PRE_DEPLOYMENT_CHECKLIST.md)** — the HITL gates.
