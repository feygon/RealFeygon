# Proposal: Add Actuals to the BurnRate Demo

## Summary

The public BurnRate demo cannot demonstrate the actuals capability. It ships a purely
projection-side dataset, so a viewer sees a model that predicts but never shows itself being
re-anchored against observed reality.

This change adds a synthetic actuals history to the demo so the demo can show the thing that
distinguishes BurnRate from a spreadsheet: the model is *maintained* against real observed values
year over year, not run once and believed.

Motivation is concrete — this gap was hit live during an interview, where the actuals capability was
the thing worth showing and the demo could not show it.

## Problem

**The capability exists; the demo does not expose it.**

In the private model, `base_year` (migration 021) anchors the projection, and advancing the model
means entering the *actual* observed balance at the new base year rather than trusting the prior
year's projection. Per `docs/base-year-maintenance.md` (BurnRate-Private), the following are
explicitly user-entered actuals at each re-base and are **not** auto-advanced:

- Starting balances — `sdira_start`, `managed_ira_start`, `pool_start`, `snt_seed`
- Real estate values — `primary_house_value`, `condo_value`, `condo_original_basis`
- Property income — `rental_income_monthly`
- Expense amounts — `lifestyle_floor_monthly`, `medical_base_monthly`, `charitable_monthly`,
  `memory_care_cost`, `nursing_low_cost`, `nursing_high_cost`

**What the demo database actually contains.** `burnrate_data/burnrate_demo.db` was inspected across
all 33 tables. There is no table or column matching `actual`, `observed`, `historic`, `recorded`, or
`realized`. Every temporal table is forward-looking: `projected_event`, `scenario_year`,
`pending_assumption`, `rate_set`. There is no prior-year record to compare a projection against, so
no projected-vs-actual view can be rendered from the demo dataset at all.

**Why this matters for the demo's purpose.** The demo's audience is interviewers and prospective
clients. A projection tool that only projects invites the obvious question — *how do you know it's
right?* Actuals is the answer, and it is currently unshowable.

## Goals

- Let the demo display at least one scenario with a real history: prior base years with observed
  values recorded alongside what the model had projected for those years.
- Let the demo show a projected-vs-actual comparison, so model drift is visible rather than asserted.
- Let the demo demonstrate a base-year advance — the re-anchoring workflow itself, not just its
  result.
- Keep the demo dataset fully synthetic and safe to serve publicly.
- Keep the demo reproducible: the actuals history must survive deployment.

## Non-Goals

- Changing the projection engine, scenario math, or any BurnRate business rule.
- Exposing any real Nickerson financial data. The demo remains alias-based and synthetic.
- Building actuals *entry* workflow in the demo if a read-only presentation is sufficient to show
  the capability — decide during spec.
- Backfilling actuals for every scenario. One well-chosen scenario may carry the demonstration.
- Reconciling the demo schema with the private schema beyond what actuals requires.

## Proposed Approach

Direction only. The spec session decides the details.

1. **Determine where actuals lives in the private model.** The private overlay
   (`Nickerson.js`, `dbcon_nickerson.js`, `scripts/NickersonCallbacks.js` — all rsync-excluded)
   is the likely home. Establish whether actuals is a distinct table, a `base_year`-stamped
   snapshot of scenario parameters, or a derived comparison — this determines everything downstream.
2. **Define the demo's actuals shape** as the minimum needed to render a projected-vs-actual view.
3. **Generate a synthetic multi-year history** for one demo scenario: two or three prior base years
   with plausible drift between projected and observed, chosen to be *interesting* — a model that
   was slightly wrong and got corrected demonstrates more than one that was perfect.
4. **Add a demo-side presentation** of the comparison.
5. **Commit the resulting demo database**, because of the deployment constraint below.

## Expected Outcome

A viewer of the public demo can see, without a walkthrough:

- What the model projected for a prior year
- What was actually observed in that year
- The variance between them
- That the model was re-anchored on the observed value and carried forward

Interview-usable as a self-contained artifact.

## Risks

- **Deployment resets demo state.** `.github/workflows/deploy.yml` rsyncs with `--delete` and the
  runner does a fresh `git checkout`, so the server's demo database is replaced by the committed
  copy on every push. Any actuals history must be **committed**, not entered at runtime — runtime
  entry will be silently wiped on the next deploy. (This is also why the demo currently shows
  `roommate_enabled` and `optimizer_enabled` off despite local toggles being on.)
- **Privacy.** The demo database's protection is structural: `party` stores `alias`, not `name`, and
  contains no real identifiers. Synthetic actuals must not weaken that. Note that alias plus date of
  birth plus state plus a specific asset profile is already a quasi-identifier set — adding a
  multi-year financial history increases that surface, so the figures must be genuinely invented
  rather than perturbed real ones.
- **Schema drift.** Adding tables or columns to the demo database that do not exist in the private
  schema creates two divergent shapes to maintain. Prefer mirroring the private shape.
- **Plausibility.** Synthetic drift that is too clean looks fabricated; too noisy looks broken. The
  demonstration depends on the numbers reading as real.
- **Scope creep into entry workflow.** Building actuals *entry* in the demo is a much larger change
  than displaying a committed history. Guard this boundary during spec.

## Open Questions

1. Is actuals a distinct persisted entity in the private model, or a re-base of scenario parameters
   with the prior values retained?
2. Does a projected-vs-actual comparison view already exist privately, or would the demo be the
   first implementation of it?
3. One scenario or all three? Which best carries the story?
4. Read-only presentation, or interactive base-year advance in the demo?
5. Should the archived pre-re-base projection be stored, or recomputed from the prior base year's
   parameters on demand?

## Status

Proposal only. `design.md`, `tasks.md`, and `requirements-review.md` are intentionally absent and
belong to the spec session that follows — per project convention, the Requirements Rubric gate runs
before decomposition.
