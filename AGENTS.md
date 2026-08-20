# DanangMap Backend Agent Guide

Đọc theo thứ tự trước khi sửa mã:

1. `docs/PRD.md`
2. `docs/SRS.md`
3. `docs/API-CONTRACT.md`
4. `docs/PLANS.md`
5. `../danangmap-frontend/docs/DESIGN.md`

Giữ kiến trúc modular monolith. Không thêm MongoDB, không dùng TypeORM `synchronize`, không để public đọc draft và không gọi trực tiếp Mapbox Geocoding/Directions. Spatial SQL nâng cao phải được tham số hóa và test bằng PostGIS thật.

OpenAPI là contract source of truth. Mọi thay đổi route hoặc DTO phải cập nhật contract, generated-client check, RBAC allow/deny tests, migration và Docker E2E liên quan.

Không tự nới separation of duties, import guardrails, field privacy hoặc publication atomicity. Không mô tả revision snapshot như backup.
