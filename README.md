# DanangMap Backend

NestJS API và background worker cho DanangMap v2 Spatial CMS.

## Tài liệu nguồn

- [PRD](docs/PRD.md)
- [SRS](docs/SRS.md)
- [API Contract](docs/API-CONTRACT.md)
- [Kế hoạch triển khai](docs/PLANS.md)
- [Runbook kích hoạt durable publication](docs/DURABLE-PUBLICATION-ACTIVATION.md)
- [Thiết kế frontend](https://github.com/duckvhuynh/danangmap-frontend/blob/main/docs/DESIGN.md)
- [GitHub Project](https://github.com/users/duckvhuynh/projects/3)

## Kiến trúc đã khóa

- NestJS modular monolith với `apps/api` và `apps/worker`.
- TypeORM, PostgreSQL/PostGIS, Redis/BullMQ và MinIO.
- Không dùng MongoDB; PostgreSQL là source of truth.
- Session nội bộ HttpOnly, MFA và strict Editor, Reviewer, Publisher separation.
- Revision bất biến, publication snapshot nguyên tử và public GeoJSON/MVT.
- Backup hiện ngoài phạm vi và được ghi nhận là accepted risk.

`ASYNC_PUBLICATION_ENABLED` vẫn mặc định `false` ở schema, `.env.example` và Compose; production chỉ
bật khi được đặt explicit `true`. Guard-intact exact-SHA pretrial đã pass, nhưng release vẫn NO-GO cho
đến khi guard-removal được review và hai run fresh-volume production-mode có evidence.
