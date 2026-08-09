---
title: "BurnRate Actuals in Demo - Session Handoff"
version: v1.0.0
created: 2026-08-09
updated: 2026-08-09
status: active
category: summaries
tags: [burnrate, demo, actuals, openspec, handoff]
---

# 📌 BurnRate Actuals in Demo — Session Handoff

**Date:** August 9, 2026
**Status:** 🟢 Proposal written, spec not started
**Next artifact:** `openspec/changes/add-actuals-to-burnrate-demo/proposal.md`

## Table of Contents

- [TL;DR](#tldr)
- [Why this exists](#why-this-exists)
- [What was verified, not assumed](#what-was-verified-not-assumed)
- [Constraints the next session must respect](#constraints-the-next-session-must-respect)
- [Where to start looking](#where-to-start-looking)
- [Other changes this session made to this repo](#other-changes-this-session-made-to-this-repo)
- [What was deliberately not done](#what-was-deliberately-not-done)

## TL;DR

The public BurnRate demo cannot show the actuals capability, and that gap was hit live during an
interview. An OpenSpec proposal now exists to close it. **The spec and implementation are
deliberately deferred to a separate session** to keep context focused.

The single most important thing to carry forward: **the demo database is replaced on every deploy**,
so any actuals history must be committed to git, not entered at runtime.

## Why this exists

BurnRate's differentiator over a spreadsheet is that the model is re-anchored against observed
reality each year rather than run once and believed. The demo shows only projections, which invites
the obvious question — *how do you know it's right?* — with no answer available on screen.

## What was verified, not assumed

- **The demo DB has no actuals of any kind.** All 33 tables in `burnrate_data/burnrate_demo.db`
  were inspected. No table or column matches `actual`, `observed`, `historic`, `recorded`, or
  `realized`. Every temporal table is forward-looking: `projected_event`, `scenario_year`,
  `pending_assumption`, `rate_set`. There is no prior-year record to compare against, so a
  projected-vs-actual view cannot be rendered from the demo dataset at all.
- **The demo DB is currently 1 commit behind local.** Two scenario parameters on `ScA_NoTrust`
  differ between the committed copy and the working tree: `roommate_enabled` and
  `optimizer_enabled`, both `0` committed and `1` locally, changed 2026-05-24. Everything else in
  all 33 tables is byte-identical. This is uncommitted local state, not a pending change.
- **The demo DB is genuinely aliased.** `party` stores `alias`, not `name`, and contains no
  occurrence of the real surname or given names.
- **Actuals semantics** come from `docs/base-year-maintenance.md` in **BurnRate-Private**:
  `base_year` (migration 021) anchors the projection, and advancing it means the user enters the
  observed balance rather than trusting the prior projection.

## Constraints the next session must respect

1. **Deployment wipes runtime demo state.** `.github/workflows/deploy.yml` rsyncs with `--delete`
   from a fresh `git checkout` on the runner. The server's `burnrate_demo.db` is overwritten by the
   committed copy on every push to `main`. Actuals data entered through the running demo will be
   silently destroyed on the next deploy. Commit it.
2. **Privacy is structural and must stay that way.** Alias + date of birth + state of residence +
   a specific asset profile is already a quasi-identifier set. A multi-year financial history
   enlarges that surface. Synthetic figures must be **invented**, not real numbers perturbed.
3. **Schema divergence is a maintenance cost.** Adding tables or columns to the demo that do not
   exist in the private schema creates two shapes to keep in sync. Prefer mirroring.
4. **Requirements Rubric gate applies.** Per project convention the spec is scored by
   `requirements-reviewer` and iterated to READY before decomposition into tasks.

## Where to start looking

| Question | Look here |
|---|---|
| What is actuals, mechanically? | `docs/base-year-maintenance.md` (BurnRate-Private) |
| Where is it implemented? | Private overlay: `Nickerson.js`, `dbcon_nickerson.js`, `scripts/NickersonCallbacks.js` — all **rsync-excluded**, so they never reach the server |
| What does the demo currently hold? | `burnrate_data/burnrate_demo.db`, 33 tables |
| How does the demo get deployed? | `.github/workflows/deploy.yml` |
| What shape should the proposal take? | `openspec/changes/reduce-burnrate-first-load-recalculation/` is the reference change |

## Unknowns to resolve

**Blocking — resolve first.** Is actuals a distinct persisted entity, or a re-base of scenario
parameters with the prior values retained? This determines the demo's data shape and everything
downstream of it. Nothing else can be specced until it is answered.

**Non-blocking, decide during spec:**

1. Does a projected-vs-actual comparison view already exist privately, or would the demo be its
   first implementation?
2. One scenario carrying the demonstration, or all three?
3. Read-only presentation of a committed history, or an interactive base-year advance? The second is
   a much larger change — guard this boundary.
4. Store the archived pre-re-base projection, or recompute it on demand from the prior base year's
   parameters?

None of these were investigated in this session. They are recorded so the next session starts from a
known list rather than rediscovering it.

## Other changes this session made to this repo

Unrelated to actuals, but relevant if something looks different:

- Repo renamed `EVE2-Project` → `RealFeygon`; **default branch switched `master` → `main`**. The
  site and BurnRate were previously invisible because the repo landed on `master`.
- `/resume/` now 301-redirects to `/spa-resume/`. It had been serving the 2018 game-project resume,
  which is now mothballed to `docs/archive/`.
- `/resume/DeceiversBlade/` removed — it referenced a file not in the repo and returned 500. The
  artifact is served by `/illusion/`.
- Autistic work-preference files moved from repo root into `docs/`; the
  `/resume/AutisticWorkPreferences/` route was retargeted and still returns 200.
- `.env.example` removed as a learning artifact. It was already excluded from the rsync.

All of the above is deployed and verified live.

## What was deliberately not done

- **No spec, design, or tasks.** `design.md`, `tasks.md`, and `requirements-review.md` are
  intentionally absent from the change directory.
- **No demo database changes.** The two local scenario toggles remain uncommitted; committing them
  would make roommate income and the DP withdrawal optimizer the demo's default state.
- **No engine changes.** The projection engine, scenario math, and business rules were not touched.
