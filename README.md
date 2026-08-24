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
bật khi được đặt explicit `true`. Local production activation gate đã được independent review chấp
nhận tại đúng backend `2d4675ec2385abf55fa23ad26914e037456f14cd` + frontend
`6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8`. Canonical stack đã merge vào `main` tại
`059e240b87869bb4b1d87da66b7698c859a34e5e`; final CI `32562513173` và exact-SHA cross-stack
`32561792134` đều xanh, nên `CROSS_REPO_READ_TOKEN` không còn là blocker. Release tổng thể vẫn
NO-GO cho các scope attachment/a11y/Mapbox/deploy và accepted no-backup risk chưa đóng.

## Coolify attachment storage

`compose.coolify.yml` chạy ClamAV riêng và chỉ cho worker kết nối qua mạng nội bộ. Trước khi deploy,
gán một domain HTTPS cho MinIO API port `9000`, rồi đặt `MINIO_PUBLIC_ENDPOINT` bằng hostname đó
(không gồm scheme/path). Mặc định `MINIO_PUBLIC_PORT=443`, `MINIO_PUBLIC_USE_SSL=true` và
`MINIO_PUBLIC_PATH_STYLE=true`; API dùng endpoint này chỉ để ký upload URL, còn đọc/ghi object nội bộ
vẫn qua service `minio:9000`. Không expose ClamAV port `3310` ra Internet.
