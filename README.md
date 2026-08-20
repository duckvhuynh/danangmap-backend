# DanangMap Backend

NestJS API và background worker cho DanangMap v2 Spatial CMS.

## Tài liệu nguồn

- [PRD](docs/PRD.md)
- [SRS](docs/SRS.md)
- [API Contract](docs/API-CONTRACT.md)
- [Kế hoạch triển khai](docs/PLANS.md)
- [Thiết kế frontend](https://github.com/duckvhuynh/danangmap-frontend/blob/main/docs/DESIGN.md)
- [GitHub Project](https://github.com/users/duckvhuynh/projects/3)

## Kiến trúc đã khóa

- NestJS modular monolith với `apps/api` và `apps/worker`.
- TypeORM, PostgreSQL/PostGIS, Redis/BullMQ và MinIO.
- Không dùng MongoDB; PostgreSQL là source of truth.
- Session nội bộ HttpOnly, MFA và strict Editor, Reviewer, Publisher separation.
- Revision bất biến, publication snapshot nguyên tử và public GeoJSON/MVT.
- Backup hiện ngoài phạm vi và được ghi nhận là accepted risk.
