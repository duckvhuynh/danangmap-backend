# Oversized revision diff — Docker regression, 2026-09-05

Scope: [#58](https://github.com/duckvhuynh/danangmap-backend/issues/58), Q-008/Q-027; unblock required CI for [#57](https://github.com/duckvhuynh/danangmap-backend/pull/57). The owner approved this test-fixture repair separately from the original documentation checkpoint. No production API, schema, diff limits, authentication policy or deployment configuration changes.

## Reproduction and cause

- Baseline: `ba25687d09d8fff168c78118067367894a06f45f`. GitHub runs [33941311477](https://github.com/duckvhuynh/danangmap-backend/actions/runs/33941311477) and [33941790546](https://github.com/duckvhuynh/danangmap-backend/actions/runs/33941790546) both timed out at 30 seconds while loading the 25,001-feature fixture, before calling the HTTP diff endpoint.
- Local reproduction used a new isolated Compose project `danangmap-issue58-r1`, PostGIS 16/3.5, Node 22.18.0, normal migrations/seed/API/worker/Redis/MinIO/Mailpit and a 2-CPU PostgreSQL limit. Published host ports were removed through a local override. Existing application containers and volumes were untouched.
- The old test passed alone (2.152 seconds for the oversized case) but failed after the integration suite in the same order as CI: 68 integration tests passed, then HTTP E2E reported 54 passed / 1 failed / 4 intentionally skipped.
- While the bulk CTE was executing, `pg_stat_activity` showed active CPU work, no wait event and no blocking PID. A separate diagnostic connection reproduced the slowdown by warming foreign-key checks on 10 small rows before the bulk insert. Its transaction was rolled back.
- `EXPLAIN (ANALYZE, BUFFERS)` measured 46.766 seconds for the original 25,001-row CTE. The insert plan itself took 0.650 seconds. Three foreign-key trigger groups consumed 13.901, 13.494 and 17.697 seconds respectively: feature version to feature, revision feature to feature, and revision feature to feature version. With an unwarmed connection the same bulk shape took about 1.2–1.4 seconds. This isolates the fixture's small-table cached FK plans/cardinality change, not the diff API or a database lock.
- The subsequent `Connection terminated` / `Cannot log after tests are done` messages were secondary: Jest timed out, then teardown destroyed the connection while fixture creation was still running. Immutable-audit rejection logs are expected negative assertions, not this failure.

## Repair

Replace the single data-modifying CTE with three bulk inserts in the same transaction. `ANALYZE features` and `ANALYZE feature_versions` refresh parent-table statistics and invalidate cached plans before dependent FK checks. Analyze the completed revision links before the HTTP read.

All normal geometry/FK constraints remain enabled. No planner is globally forced, no migration/index is introduced, and the 30-second Jest timeout is unchanged. The HTTP request still goes to the real running API with the reviewer session. A joined-count assertion now proves exactly 25,001 distinct linked feature/version records before requesting the diff; the response must still be HTTP 422 with `DIFF_TOO_LARGE`, `COMPLEXITY_LIMIT`, `currentFeatures: 25001`, and `maxFeaturesPerSide: 25000`.

## Local verification

- Rebuilt Docker test image with the repair; full publication/history file: **7/7 passed**, oversized case **1.605 seconds**, including the new fixture-integrity assertion.
- Repeated full HTTP E2E on the diagnostic stack: **13 suites passed, 55 tests passed, 4 intentionally skipped**, 64.810 seconds. The unchanged flag-off async-publication suite accounts for the skips; flag-on coverage is a separate checkpoint.
- Fresh-volume project `danangmap-issue58-r2`, same images/configuration and CI suite order: **21 integration suites / 68 tests passed** (18.757 seconds), followed by **13 HTTP E2E suites / 55 tests passed, 4 intentionally skipped** (59.643 seconds). Publication/history passed in 25.089 seconds including teardown. No baseline profiler or manual statistics maintenance ran on this second database.
- Local lint, typecheck and **27 unit suites / 126 tests** passed.
- Flag-on API/worker checkpoint on the second project: **4/4 async publication HTTP tests passed** (4.227 seconds). Repository formatting and OpenAPI consistency passed (**96 operation IDs**, no generated-contract diff).
- Verified teardown left **zero** `diff-limit-*` layers and all three audit/workflow immutability triggers enabled.

Fresh-volume repeat results and exact-head required CI/merge evidence are recorded in #58/#56. Passing backend HTTP tests is not a new frontend browser E2E run or staging sign-off. M7/M8 and the other tracked regressions remain outside this change.
