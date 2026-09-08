# `config/tracks/<track>.yaml`

All 17 target tracks from
[README.md#scope-the-17-tracks](../../docs/LLM%20PLAN/README.md#scope-the-17-tracks) are
authored here — `label`, `purpose`, `renderer`, `strata`, `rowsPerUser`, `sampling.mode`, and
the rubric-pack pointer are copied from that table and from
[00-architecture-and-parametrization.md](../../docs/LLM%20PLAN/03-build-plan/00-architecture-and-parametrization.md#configtracksltrackgtyaml).
`datasource` table/column names come only from the entries verified against the live
CosmicGuidance repo in `docs/REBUILD-PLAN.md` §1.4; anything not confirmed there is left out
rather than guessed.

All 17 are `status: active` as of 2026-09-08 — both blockers that used to gate 8 of
them are now closed in `config/blockers.yaml`:

- `synastry_*`, `composite_*`, `number_compatibility_*` — `partner-coverage-policy`
  closed after verifying `eval_dataset_cases` covers all 100 actors for these tracks
  (200 rows each, brief+detailed), with real named partners for actors 002–005 — the
  "5 actors have no partner" premise in `docs/REBUILD-PLAN.md` §1.5 does not match
  what's actually stored and should be corrected there.
- `numerology_brief`, `numerology_detailed` — `numerology-silver-source` closed as a
  **policy decision**, not a data finding: this evaluation does not use a separate
  silver/gold reference for any track; the candidate readings already in
  `eval_dataset_cases`/`eval_generations` are the final dataset.
  `config/models.yaml` sets `includeSilverAsBlindArm: false` accordingly. Note this
  is unrelated to `eval_dataset_cases.gold_output` / `eval_reference_generations`,
  which are a separate, still-active legacy concept used by the current admin
  dashboard and `cb-actor-001` benchmark scripts — left in place, not touched.

`server/core/config/loader.ts#loadTrackSpecs` cross-checks each file's `status` against
`config/blockers.yaml` and throws if they disagree, so this list can't silently drift from the
registry. This is config authoring only — the `Datasource`/`Renderer` adapter implementations
that would actually read these tables do not exist yet (see `docs/REBUILD-PLAN.md` §8).
