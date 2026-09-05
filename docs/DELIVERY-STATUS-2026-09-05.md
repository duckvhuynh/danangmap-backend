# Delivery checkpoint — 2026-09-05

## Scope and baseline

Owner requested reconciliation of plans, GitHub issues/Project and outstanding QA after making both repositories public. This checkpoint does not start M7/M8, deploy Coolify, change application behavior or rewrite staging data.

| Repository | Remote main = staging baseline             | Latest main CI                                                                                     |
| ---------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Backend    | `aad5065265f5037aa4dd4b9d88e25a2ee1e25807` | [33864138926 — success](https://github.com/duckvhuynh/danangmap-backend/actions/runs/33864138926)  |
| Frontend   | `9f24c21ba9bc0aaea7047d7b98a8f39025ff02ef` | [33886744545 — success](https://github.com/duckvhuynh/danangmap-frontend/actions/runs/33886744545) |

Both canonical worktrees were clean at the start; no open PRs existed. Documentation changes for this checkpoint use separate branches/PRs, not direct main pushes. Branch SHAs are not evidence of deployed Coolify image SHAs.

## Governance: C-017

GitHub reports both repositories PUBLIC. The former private-plan HTTP 403 is resolved. Main protection was configured through GitHub REST, then read back successfully on both repositories:

| Setting                                  | Backend                        | Frontend                                                                 |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------------------------------ |
| Required checks                          | `verify`                       | `Contract, quality, tests, and build`; `Non-root container health smoke` |
| Check publisher                          | GitHub Actions app ID `15368`  | GitHub Actions app ID `15368`                                            |
| Up-to-date branch required               | true                           | true                                                                     |
| Required approving reviews               | 0 (owner-approved solo policy) | 0 (owner-approved solo policy)                                           |
| CODEOWNER review / dismiss stale reviews | false / true                   | false / true                                                             |
| Enforce admins / conversation resolution | true / true                    | true / true                                                              |
| Allow force pushes / deletions           | false / false                  | false / false                                                            |

Read-only verification commands:

```powershell
gh api repos/duckvhuynh/danangmap-backend/branches/main/protection
gh api repos/duckvhuynh/danangmap-frontend/branches/main/protection
```

Only main was changed. Staging protection was not silently added: its push workflow does not run the same required checks. The conditional backend `cross-stack-browser` job was not added as a required check because it skips ordinary main pushes/most PRs; release coverage remains frontend #25.

### Owner-approved solo-maintainer policy

Both repositories have only `duckvhuynh` as collaborator/CODEOWNER. GitHub rejected self-approval by this PR author. On 2026-09-05 the owner explicitly approved removing mandatory approval/CODEOWNER review while retaining PRs and successful CI. Only the review settings were PATCHed: approving review count 0, CODEOWNER review false. Required checks, strict freshness, admin enforcement, conversation resolution and force-push/delete protections remain unchanged. No account access was granted and no admin merge bypass is authorized.

Proof PR links/read-back evidence are recorded in [foundation #2](https://github.com/duckvhuynh/danangmap-backend/issues/2) and [delivery #56](https://github.com/duckvhuynh/danangmap-backend/issues/56). Configuration completion and documentation-merge completion are separate states.

Proof PRs: [backend #57](https://github.com/duckvhuynh/danangmap-backend/pull/57) and [frontend #47](https://github.com/duckvhuynh/danangmap-frontend/pull/47). Initial read-back showed REVIEW_REQUIRED/BLOCKED under the original one-review policy; this historical observation is not the final policy. Under the owner-approved amendment, PR and CI gates remain required but approval is optional. Frontend #47 merged normally at `912f040fdad3505c572e64ecc3baddeb5bf0f7a4` after both required checks passed. Backend CI runs 33941311477 and 33941790546 failed during 25,001-record fixture creation (30-second test timeout). The owner then approved the scoped fixture repair in [#58](https://github.com/duckvhuynh/danangmap-backend/issues/58); see the [Docker regression report](qa-oversized-diff-fixture-2026-09-05.md). Do not merge on a failed check or weaken the test. Final CI/merge evidence is recorded in #56/#58. Neither staging branch was promoted by this checkpoint.

## Plans and Project reconciliation

- Baseline Project contained 43 items: 39 Done, 1 Blocked, 3 Todo; 40 issues plus 3 PR items. M0/M2–M6 were Done.
- Replaced the stale operational checklist with a current one; preserved its original assertions and historical evidence in `archive/EXECUTION-CHECKLIST-before-20260905.md`.
- PLANS currently defines 172 backlog IDs: C=17, B=69, F=47, D=10, Q=29. The historical count 169 was stale after B-069/Q-028/Q-029 were added. No IDs/requirements were added or deleted by this reconciliation.
- Corrected current repository visibility and Lucide design decision; did not retroactively change old test claims.
- Updated obsolete Project Dependency text for closed contracts, attachment diff, identity and durable-sync issues. Frontend #25 no longer treats closed/superseded PR #6 or completed backend #11/frontend #4 as active blockers.
- New regression issues do not silently reopen all completed milestones. M7/backend #6 and M8/backend #7/frontend #25 remain deferred.

## Explicit follow-up work

| Issue                                                                      | Scope                                                            | Completion boundary                                                                                                                      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [Backend #54](https://github.com/duckvhuynh/danangmap-backend/issues/54)   | Invalid simplified Bàn Thạch seed geometry                       | Valid fixture, real PostGIS validity assertions, fresh/repeat seed and public/admin polygon regression; no silent deployed-data rewrite. |
| [Backend #55](https://github.com/duckvhuynh/danangmap-backend/issues/55)   | Canonical no-mock scanner versus intentional network-fault tests | Separate suites while retaining both coverage and strict no-mock enforcement; deferred under M8/frontend #25.                            |
| [Backend #56](https://github.com/duckvhuynh/danangmap-backend/issues/56)   | This governance/docs/Project reconciliation                      | Documentation PRs with required CI and owner-approved review policy; truthful QA evidence, no admin bypass.                              |
| [Frontend #46](https://github.com/duckvhuynh/danangmap-frontend/issues/46) | Staging import/lifecycle regression                              | Public smoke partly complete; authenticated role sessions and deployed image SHAs still needed.                                          |

Seed evidence comes from the local 04/09 PostGIS audit (`ST_IsValid=false`, self-intersection); seed coordinates remain unchanged. It is not evidence that staging contains this seeded boundary. Editor fit/focus and ResizeObserver are already implemented by frontend PR #45; the old camera finding is not an unimplemented feature.

## Tests: what is and is not proven

- Documentation validation passed: the same 172 backlog IDs as the pre-change main, no duplicate/missing dependency/cycle, original archived checklist evidence preserved, and all three local Markdown links in new reports/checklist resolve. Prettier checks for the new operational reports/checklist and git diff --check passed. This is documentation validation, not application E2E.

- Existing backend main CI includes real Docker migration, integration/HTTP E2E, mail/readiness degradation and async publication checks. Its cross-stack-browser job was **skipped**.
- Frontend main CI covers generated contract, lint, typecheck, unit/component, production build and non-root container health. It does not yet execute the complete release browser/security gate.
- Frontend `docs/admin-role-e2e-2026-09-04.md` reports 11/11 real-stack role journeys. Its narrowed eight-spec image excludes intentional network fault-injection sources; backend #55 records this limitation instead of claiming the unchanged canonical harness passed.
- Browser-only staging public smoke on 05/09 observed published agency data, toggle/empty state, list/detail, Vietnamese combined search and basemap-control state. The admin route reached login with no authenticated session. See frontend `docs/staging-qa-2026-09-05.md`.
- Initial reconciliation changed documentation only. The later owner-approved #58 repair changes the oversized-diff test fixture, not application behavior; new isolated Docker test stacks were built and executed as documented in the linked regression report. The existing manual local stack was not rebuilt or modified. PR CI results remain separate from local evidence.
- No production release, full device/a11y/performance sign-off, backup capability or Mapbox URL restriction is claimed.
