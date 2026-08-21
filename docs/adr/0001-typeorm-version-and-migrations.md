# ADR 0001 — Pin TypeORM 0.3 for the MVP migration lifecycle

- Status: accepted
- Date: 2026-08-21

## Context

TypeORM 1.x is available, but DanangMap needs a predictable `DataSource`-based CLI and migration lifecycle across local Docker, CI and Coolify before adopting a new major line. Database changes must be migration-only and reproducible; production must never use `synchronize`.

## Decision

Pin TypeORM to `0.3.31` for the MVP. This is the latest audited `0.3.x` release at the time of this decision and retains the verified `DataSource` CLI contract without opting into the 1.x major line. Use one explicit `DataSource`, checked-in migrations and a one-shot migration container guarded by the release workflow. Both runtime configurations set `synchronize: false` and `migrationsRun: false`.

## Consequences

- Migration/DataSource behavior is stable for the first release.
- TypeORM 1.x adoption requires a dedicated compatibility spike, migration rehearsal and contract-preserving upgrade PR.
- The dependency is pinned deliberately rather than following `latest` implicitly.
