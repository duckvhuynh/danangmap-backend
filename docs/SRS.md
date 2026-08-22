# SRS — DanangMap Backend

> Software Requirements Specification
> Trạng thái: baseline cho MVP
> Ngôn ngữ quy phạm: các từ **PHẢI**, **KHÔNG ĐƯỢC**, **NÊN**, **CÓ THỂ** được hiểu theo RFC 2119.

## 1. Mục đích và phạm vi

DanangMap Backend là nền tảng quản trị và phân phối dữ liệu không gian cho bản đồ số thành phố Đà Nẵng. Hệ thống thay thế cách đọc JSON tĩnh bằng một nguồn dữ liệu có quản trị, hỗ trợ:

- định nghĩa lớp dữ liệu và schema metadata động;
- biên tập geometry và thuộc tính;
- nhập CSV, XLSX, GeoJSON, KML;
- kiểm duyệt độc lập theo luồng Editor → Reviewer → Publisher;
- xuất bản snapshot bất biến cho public map;
- tìm kiếm kết hợp dữ liệu nội bộ và Geo Service bên ngoài;
- audit đầy đủ và khôi phục phiên làm việc biên tập từ IndexedDB/Dexie.

SRS này quy định backend, API và các ràng buộc tích hợp frontend. Chi tiết route và payload nằm trong `API-CONTRACT.md`.

## 2. Quyết định đã chốt

| Chủ đề                    | Quyết định                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Kiến trúc                 | NestJS modular monolith; `apps/api` phục vụ HTTP, `apps/worker` xử lý job                         |
| Cơ sở dữ liệu             | PostgreSQL + PostGIS là source of truth duy nhất                                                  |
| ORM                       | TypeORM; chỉ dùng migration, `synchronize=false` ở mọi môi trường                                 |
| Queue/cache               | Redis + BullMQ                                                                                    |
| Object storage            | MinIO tương thích S3                                                                              |
| MongoDB                   | Không dùng                                                                                        |
| Public client             | Chỉ frontend DanangMap trong MVP                                                                  |
| Auth admin                | Tài khoản nội bộ; session opaque trong cookie HttpOnly; MFA bắt buộc                              |
| Tạo tài khoản             | System Admin tạo thủ công, gửi invite hoặc import danh sách                                       |
| Workflow                  | Editor, Reviewer, Publisher tách biệt nghiêm ngặt                                                 |
| Geometry editor           | Frontend dùng Terra Draw                                                                          |
| Circle                    | Tâm là đúng một Point; MultiPoint bị cấm; lưu `radius_m` theo mét                                 |
| Import                    | Tối đa chính xác 25 MiB/file (26.214.400 byte); append/replace/upsert; tùy chọn bỏ qua record lỗi |
| ID feature                | UUID do server tạo cho mọi feature mới                                                            |
| Attachment                | Có image và attachment                                                                            |
| Phân quyền theo layer     | Không thuộc phạm vi MVP                                                                           |
| Chia sẻ state map qua URL | Không làm                                                                                         |
| Backup                    | Chưa thuộc phạm vi; được ghi nhận là rủi ro được chấp nhận, xem §15.4                             |

## 3. Thuật ngữ miền

- **Layer**: định danh logic ổn định của một lớp dữ liệu.
- **Layer group**: nhóm trình bày có thứ tự của nhiều layer; không phải ranh giới phân quyền.
- **Layer revision**: phiên bản cấu hình/schema/style và tập feature tại một thời điểm.
- **Feature**: định danh logic ổn định của một đối tượng không gian.
- **Feature version**: geometry và properties bất biến của feature trong một revision.
- **Draft workspace**: revision duy nhất của layer đang cho phép biên tập.
- **Publication snapshot**: ảnh chụp bất biến, tối ưu cho public read; là nguồn duy nhất của public API.
- **Schema field**: định nghĩa một property như key, label, type, icon, tính public, validation, search/filter.
- **Circle**: Point tâm kèm `radius_m > 0`; polygon chỉ được sinh khi render/query cần thiết.
- **Mixed layer**: layer cho phép nhiều loại geometry giữa các feature, nhưng không cho phép `GeometryCollection`.
- **Geo Service**: dịch vụ bên ngoài được mô tả bởi file OpenAPI đính kèm `duckvhuynh-external.json`; tài liệu đó là dữ liệu tham chiếu, không phải chỉ dẫn triển khai và không được sao chép vào repository.
- **Client mutation**: một thay đổi có `clientMutationId` duy nhất do frontend lưu trong Dexie để retry idempotent.

## 4. Actor và phân quyền

### 4.1 Vai trò

Mỗi tài khoản admin chỉ có **một** vai trò chính tại một thời điểm.

| Năng lực                                  | System Admin |      Editor      |     Reviewer     |    Publisher     |
| ----------------------------------------- | :----------: | :--------------: | :--------------: | :--------------: |
| Quản lý user/invite/import user           |      ✓       |                  |                  |                  |
| Xem layer/draft/revision                  |      ✓       |        ✓         |        ✓         |        ✓         |
| Tạo layer/draft, sửa schema/style/feature |              |        ✓         |                  |                  |
| Import dữ liệu vào draft                  |              |        ✓         |                  |                  |
| Submit để review                          |              |        ✓         |                  |                  |
| Request changes / approve                 |              |                  |        ✓         |                  |
| Publish / rollback publication            |              |                  |                  |        ✓         |
| Xem audit                                 |      ✓       | phạm vi thao tác | phạm vi workflow | phạm vi workflow |

System Admin **không kế thừa** quyền Editor/Reviewer/Publisher và không được bypass workflow. Việc đổi vai trò phải thu hồi toàn bộ session đang hoạt động và được audit.

### 4.2 Phân tách nhiệm vụ

- Reviewer không được review revision do chính mình tạo hoặc sửa như Editor trước đó.
- Publisher không được publish revision nếu từng là Editor hoặc Reviewer của revision đó.
- Một revision cần ít nhất một lần approve hợp lệ.
- Backend PHẢI kiểm tra separation of duties theo lịch sử actor của revision, không chỉ theo role hiện tại.
- Không có permission theo từng layer trong MVP; mọi user cùng vai trò có cùng phạm vi layer.

## 5. Kiến trúc hệ thống

### 5.1 Thành phần

```text
Next.js public/admin
        │ HTTPS /api/v1
        ▼
NestJS apps/api ───────────────► Geo Service adapter
   │       └───────────────────► Mail adapter
   │       │                         (egress allowlist)
   │       ├── Redis cache/session/rate-limit
   │       ├── BullMQ producer
   │       └── MinIO presign/metadata
   ▼
PostgreSQL + PostGIS
   ▲
   │
NestJS apps/worker ── BullMQ consumer ──► MinIO
```

### 5.2 Feature modules

- `identity`: user, password, invite, import user, MFA, session, CSRF.
- `mail`: adapter gửi invite/reset, outbox retry và redaction; không chứa logic identity.
- `authorization`: role guard, separation-of-duties policy.
- `layers`: layer identity, revision, schema, style, draft lifecycle.
- `features`: feature/version, geometry validation, spatial query, batch mutation.
- `workflow`: submit, request changes, approve, publish, rollback.
- `imports`: upload, inspect, mapping, validation, apply.
- `attachments`: presigned upload, finalize, scan status, binding.
- `public-catalog`: published catalog, feature detail, GeoJSON, MVT.
- `search`: internal search và normalized Geo Service results.
- `geo-service`: anti-corruption adapter; không để DTO bên ngoài rò vào domain.
- `audit`: append-only audit events.
- `jobs`: BullMQ producer/consumer, progress và retry policy.
- `health`: liveness, readiness, dependency status.

Module trao đổi qua interface/injection token và domain event; không phụ thuộc vòng. Controller chỉ validate/authorize/orchestrate; repository cô lập TypeORM và SQL không gian.

## 6. Mô hình dữ liệu yêu cầu

### 6.1 Thực thể chính

| Bảng                          | Thuộc tính tối thiểu                                                                                                                                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `users`                       | `id uuid`, email chuẩn hóa, username, display name, password hash, role, status, MFA status, timestamps                                                                                                                 |
| `user_mfa_methods`            | TOTP secret đã mã hóa, verified time; recovery code chỉ lưu hash                                                                                                                                                        |
| `admin_sessions`              | opaque token hash, user id, CSRF binding, expiry, revoked time, IP/UA metadata                                                                                                                                          |
| `invites`                     | token hash, role, email, expiry, used/revoked time                                                                                                                                                                      |
| `password_reset_tokens`       | token hash, user id, expiry, used/revoked time, request metadata                                                                                                                                                        |
| `user_import_jobs`            | object key, status/counts, mapping, actor, timestamps; không chứa password/MFA secret                                                                                                                                   |
| `mail_outbox`                 | template key, recipient reference, encrypted/minimized payload, status/attempts/next attempt, correlation ID; không lưu raw auth token lâu hơn cần thiết                                                                |
| `layer_groups`                | `id uuid`, unique slug, title, description, display order, archived time                                                                                                                                                |
| `layers`                      | `id uuid`, unique slug, nullable group id, display order, created by, archived time                                                                                                                                     |
| `layer_revisions`             | `id uuid`, layer id, integer revision no., status, title, description, geometry mode, style/render config JSONB, popup config JSONB, schema version, lock version, creator, optional supersedes revision id, timestamps |
| `layer_fields`                | revision id, stable field id, key, label, type, icon, flags, order, validation JSONB, display config JSONB                                                                                                              |
| `features`                    | `id uuid`, layer id, optional normalized `external_source` + `external_id`, created time, soft-delete time; unique `(layer_id, external_source, external_id)` khi có                                                    |
| `feature_versions`            | `id uuid`, feature id, revision id, geometry `geometry(Geometry,4326)`, `properties jsonb`, `radius_m`, checksum, actor, timestamps                                                                                     |
| `revision_features`           | revision id, feature id, feature version id, ordinal; unique `(revision_id, feature_id)`                                                                                                                                |
| `publication_snapshots`       | id, layer id, revision id, status, published by/time, generation, manifest/checksum, feature count, materialized public source descriptor                                                                               |
| `layer_publications`          | layer id, active snapshot id, previous snapshot id, atomic pointer timestamp                                                                                                                                            |
| `workflow_events`             | revision id, from/to state, actor, reason/comment, immutable timestamp                                                                                                                                                  |
| `revision_participants`       | revision id, user id, participation type: edit/review/publish                                                                                                                                                           |
| `import_jobs`                 | id, revision id, object key, format, mode, mapping JSONB, status/progress/counts, actor, timestamps                                                                                                                     |
| `import_issues`               | job id, row/feature reference, severity, code, field, message, raw excerpt đã lọc                                                                                                                                       |
| `attachments`                 | id, object key, MIME, bytes, checksum, scan status, owner, timestamps                                                                                                                                                   |
| `feature_version_attachments` | feature version id, attachment id, field key, display order; immutable cùng feature version                                                                                                                             |
| `audit_logs`                  | id, actor, action, resource type/id, request id, before/after digest, metadata, immutable timestamp                                                                                                                     |
| `client_mutations`            | revision id, client id, mutation id, applied server cursor, response digest; unique idempotency key                                                                                                                     |

Mọi thời gian dùng `timestamptz`; ID public dùng UUID; chuỗi dùng `text` kèm CHECK domain-specific thay vì `varchar(n)` tùy tiện.

### 6.2 Geometry và chỉ mục

- SRID lưu trữ PHẢI là EPSG:4326.
- Geometry hợp lệ: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon.
- `GeometryCollection`, Z/M coordinate và geometry rỗng bị từ chối trong MVP.
- Polygon PHẢI được kiểm tra `ST_IsValid`; normalization chỉ được thực hiện khi user đã xem cảnh báo hoặc import mapping cho phép rõ ràng.
- GIST index trên geometry của feature version/public snapshot.
- B-tree index trên khóa ngoại, trạng thái, `(layer_id, revision_no)`, thời gian và active snapshot.
- GIN index cho `properties jsonb` chỉ khi query thực tế cần; field searchable/filterable thường xuyên NÊN có expression/generated-column index được migration quản lý.
- Spatial query PHẢI dùng bbox/operator index-friendly trước predicate chính xác; không bọc cột geometry trong phép biến đổi làm mất index.
- Một feature có tối đa 100.000 vertex và property payload tối đa 64 KiB sau UTF-8 JSON serialization. Giới hạn có thể cấu hình thấp hơn; tăng cao hơn cần capacity review và benchmark.

### 6.3 Schema field

Các type MVP: `text`, `long_text`, `number`, `integer`, `boolean`, `date`, `datetime`, `url`, `email`, `phone`, `enum`, `multi_enum`, `address`, `image`, `attachment`.

Mỗi field có:

- `key`: ổn định trong revision, regex `^[a-z][a-z0-9_]{1,63}$`;
- `label`, `description`, `icon`;
- `required`, `public`, `searchable`, `filterable`, `sortable`;
- `defaultValue`, `validation`, `options`, `displayOrder`;
- `sensitive=false`, `offlineCache=true` mặc định;
- `sensitive=true` bắt buộc kéo theo `offlineCache=false`; field `public=false` không bao giờ xuất hiện ở public snapshot/API.

Đổi type hoặc xóa field có dữ liệu PHẢI chạy impact analysis và không được áp dụng nếu làm mất dữ liệu mà chưa xác nhận.

## 7. Yêu cầu chức năng

### 7.1 Identity và session

| ID       | Yêu cầu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AUTH-001 | System Admin tạo user thủ công, tạo invite có hạn dùng hoặc import danh sách user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| AUTH-002 | Không có public registration. Email và username không phân biệt hoa thường và phải unique.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AUTH-003 | Password lưu bằng Argon2id với tham số được benchmark; không log hoặc trả password.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AUTH-004 | MFA TOTP là bắt buộc. User mới chỉ có pre-auth session cho đến khi enroll và xác minh MFA.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| AUTH-005 | Session dùng random opaque token tối thiểu 256-bit; DB chỉ lưu hash; cookie HttpOnly, Secure, SameSite=Lax, Path=/, ưu tiên prefix `__Host-`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| AUTH-006 | Mọi mutation dùng cookie PHẢI kiểm tra CSRF token và Origin/Referer allowlist. Sau khi public cookie được thiết lập, `GET /auth/csrf` PHẢI reuse token đó; hai public request cold chưa có cookie có thể cấp token khác nhau và cookie response cuối thắng. Trong cùng pre-auth/authenticated session, endpoint PHẢI non-mutating/idempotent và trả cùng token kể cả khi nhiều tab gọi đồng thời; session active chỉ trả token cookie đã bind nếu hash khớp và fail closed `403 CSRF_INVALID` khi thiếu/sai mà không rebind hay update DB. Token chỉ rotate tại trust/session boundary public → pre-auth → authenticated hoặc khi tạo/rotate session mới do password/session-security transition. |
| AUTH-007 | Hỗ trợ logout phiên hiện tại, revoke-all gồm cả session đang gọi, reset password và recovery code một lần; revoke-all xóa cookie, buộc login lại và retry tuần tự bằng cookie cũ trả `401`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| AUTH-008 | Login/MFA/reset bị rate limit, lockout tăng dần và audit; thông báo không được tiết lộ user tồn tại.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| AUTH-009 | Đổi password PHẢI rotate session hiện tại và revoke mọi session còn lại; đổi role, trạng thái hoặc MFA PHẢI revoke toàn bộ session liên quan. Các command password/revoke-all có receipt idempotent và concurrent duplicate chỉ tạo một effect.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| AUTH-010 | Invite có endpoint inspect an toàn và accept một lần; accept đặt password, sau đó bắt buộc enroll MFA trước khi có admin session.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| AUTH-011 | Password reset request PHẢI trả generic `202` với timing tương đương cho account có/không tồn tại, có idempotency/rate limit. Token random một lần chỉ lưu hash, được copy/paste và chỉ nhận trong body (không URL/browser storage/log); confirm nguyên tử revoke mọi authenticated/pre-auth session, pending challenge và reset token, rồi yêu cầu login + MFA lại.                                                                                                                                                                                                                                                                                                                              |
| AUTH-012 | User tự regenerate recovery codes sau khi xác minh password + MFA; System Admin chỉ được reset MFA để buộc re-enroll, không xem/generate code thay user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AUTH-013 | Import user đi qua inspect → validate/dry-run → apply → report; account hợp lệ được tạo ở trạng thái invite/inactive, không import password/MFA secret.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| AUTH-014 | User được tạo thủ công với `mustChangePassword=true`; guard backend trung tâm chặn mọi route admin/domain bằng `PASSWORD_CHANGE_REQUIRED` cho đến khi đổi password, chỉ cho phép tập route auth tối thiểu cần hoàn tất flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 7.2 Layer, revision và feature

| ID      | Yêu cầu                                                                                                                                |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| LYR-001 | Editor tạo layer với slug unique, loại geometry, schema và style.                                                                      |
| LYR-002 | Mỗi layer chỉ có tối đa một active draft trong MVP.                                                                                    |
| LYR-003 | Draft khởi tạo từ published snapshot gần nhất hoặc rỗng; không copy blob geometry không cần thiết.                                     |
| LYR-004 | Editor thêm/sửa/xóa mềm feature và properties theo schema.                                                                             |
| LYR-005 | Server luôn tạo UUID cho feature mới; client không quyết định canonical ID.                                                            |
| LYR-006 | Mutation dùng `ETag`/`If-Match` hoặc batch cursor; conflict trả 409/412, không last-write-wins âm thầm.                                |
| LYR-007 | API batch mutation idempotent theo `(revisionId, clientId, clientMutationId)`.                                                         |
| LYR-008 | Circle chỉ nhận Point tâm và `radius_m` > 0; các unit khác được frontend chuyển sang mét.                                              |
| LYR-009 | Mixed layer cho phép geometry kinds đã cấu hình; cấm GeometryCollection.                                                               |
| LYR-010 | Attachment/image chỉ bind sau khi upload finalize và qua kiểm tra MIME/checksum/scan policy.                                           |
| LYR-011 | Archive layer là soft delete, không xóa snapshot đang được tham chiếu.                                                                 |
| LYR-012 | Editor quản lý layer group, `groupId` và display order; group chỉ phục vụ catalog/UI, không thay RBAC.                                 |
| LYR-013 | `popupConfig` được validate bằng allowlist, version hóa trong layer revision và chỉ tham chiếu field public khi tạo public projection. |
| LYR-014 | Giá trị field `image                                                                                                                   | attachment`là danh sách attachment ID có thứ tự được materialize từ`feature_version_attachments`; bind/unbind/reorder luôn tạo feature version mới, không sửa version cũ. |

### 7.3 Dexie autosave và recovery

| ID       | Yêu cầu                                                                                                                                                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SYNC-001 | IndexedDB/Dexie là bộ đệm khôi phục trên thiết bị, không phải source of truth và không thay thế Save lên server.                                                                                                                                              |
| SYNC-002 | Frontend lưu local snapshot, `serverCursor`, ETag và hàng đợi mutation chưa ack theo user/layer/revision/client.                                                                                                                                              |
| SYNC-003 | Backend cung cấp workspace snapshot, change feed theo cursor và batch mutation idempotent.                                                                                                                                                                    |
| SYNC-004 | Sau reload, client pull thay đổi server, rebase mutation chưa ack, hiển thị conflict để user chọn; không tự ghi đè.                                                                                                                                           |
| SYNC-005 | Server trả mapping `clientMutationId → status/canonicalFeatureId/serverCursor`.                                                                                                                                                                               |
| SYNC-006 | Cursor có hạn lưu. Nếu cursor quá cũ, server trả `SYNC_CURSOR_EXPIRED` cùng chỉ dẫn fetch full workspace.                                                                                                                                                     |
| SYNC-007 | Logout chủ động/xóa user PHẢI yêu cầu frontend xóa database Dexie của principal. Session hết hạn chỉ khóa recovery cho tới khi cùng principal re-auth; user khác không được thấy metadata. Không lưu session token, MFA secret hay URL presigned trong Dexie. |
| SYNC-008 | Draft local phải có quota guard; attachment binary không lưu lâu trong IndexedDB, chỉ lưu metadata/trạng thái upload.                                                                                                                                         |
| SYNC-009 | Backend không cấp editor lease. Concurrency dùng optimistic ETag/version và idempotent mutation; Web Locks/Dexie lease chỉ phối hợp tab cục bộ.                                                                                                               |
| SYNC-010 | Batch có `origin=editor                                                                                                                                                                                                                                       | recovery`; mutation recovery được audit. Conflict resolve phải nêu explicit strategy và base/current version, không merge geometry tự động. |

### 7.4 Import

| ID      | Yêu cầu                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IMP-001 | Chấp nhận CSV, XLSX, GeoJSON, JSON được sniff/validate như GeoJSON và KML, tối đa chính xác 25 MiB/file (26.214.400 byte). Kiểm tra kích thước cả trước và trong stream.                                                          |
| IMP-002 | Pipeline bắt buộc: upload → inspect → map → validate/dry-run → apply.                                                                                                                                                             |
| IMP-003 | Job chạy ở worker; API trả 202 và progress; trạng thái durable trong PostgreSQL.                                                                                                                                                  |
| IMP-004 | Mode: append, replace, upsert. Replace chỉ thay nội dung draft, không tác động public snapshot.                                                                                                                                   |
| IMP-005 | Với upsert, matching chỉ dùng canonical `feature_id` hoặc cặp `(external_source, external_id)` unique trong layer. Record không match được tạo UUID mới. Nếu không có match key, upsert hoạt động như append và phải cảnh báo rõ. |
| IMP-006 | User chọn `skipInvalid=true`; record lỗi bị loại và report được lưu. Nếu false, bất kỳ error nào làm apply thất bại toàn bộ.                                                                                                      |
| IMP-007 | CSV hỗ trợ chọn encoding/delimiter và cột latitude/longitude; XLSX hỗ trợ chọn sheet; GeoJSON hỗ trợ Feature/FeatureCollection; KML được parse an toàn, không resolve external entity/network link.                               |
| IMP-008 | CRS khác 4326 chỉ được transform nếu nhận diện chắc chắn hoặc user chọn rõ; nếu không, validation fail.                                                                                                                           |
| IMP-009 | Apply chạy transaction/chunk staging có tính nguyên tử theo job; retry không tạo duplicate.                                                                                                                                       |
| IMP-010 | Report có tổng record, valid, warning, invalid, inserted, updated, skipped và lỗi theo dòng/feature.                                                                                                                              |
| IMP-011 | Chống zip bomb/XML bomb/formula injection/path traversal; không chạy macro/formula; raw cell chỉ được log ở dạng rút gọn và lọc dữ liệu nhạy cảm.                                                                                 |
| IMP-012 | Cancel chỉ đảm bảo trước phase commit; khi commit đã bắt đầu, hệ thống hoàn tất hoặc rollback transaction.                                                                                                                        |
| IMP-013 | Mỗi job tối đa 100.000 record/feature, 2.000.000 vertex tổng và 250 MiB dữ liệu expanded/uncompressed. XLSX tối đa 10 sheet, chọn đúng một sheet/job và tối đa 256 cột.                                                           |
| IMP-014 | Database giữ tối đa 20.000 issue/job để truy vấn; full report được lưu tại MinIO. Các limit có thể cấu hình thấp hơn; tăng cao hơn cần capacity review.                                                                           |

### 7.5 Workflow và publication

| ID      | Yêu cầu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WFL-001 | State của submitted revision: `draft → in_review → changes_requested` hoặc `in_review → approved → publishing → published`; failure publish trở về `approved` với lỗi. Request changes giữ revision gốc bất biến ở `changes_requested` và tạo successor `draft`.                                                                                                                                                                                                                                                                                                          |
| WFL-002 | Submit khóa revision, chạy validation đầy đủ và ghi manifest/checksum.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| WFL-003 | Request changes bắt buộc comment; approve có comment tùy chọn.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| WFL-004 | Separation-of-duties được kiểm tra ở mọi transition và rollback bằng participant history bất biến. Create/update/delete feature và import apply ghi `edit`; actor từng edit/review vẫn bị deny publish/rollback sau khi đổi role; System Admin không bypass.                                                                                                                                                                                                                                                                                                              |
| WFL-005 | Mặc định `ASYNC_PUBLICATION_ENABLED=false`, publish đồng bộ không đổi: request chỉ trả terminal sau khi snapshot và active pointer commit nguyên tử. Client dùng trạng thái indeterminate trong lúc chờ; chỉ snapshot đã commit có `progress=100`, không tạo phần trăm trung gian giả.                                                                                                                                                                                                                                                                                    |
| WFL-006 | Public cache chỉ invalidate sau khi pointer đổi thành công.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| WFL-007 | Rollback chỉ đến snapshot `published` đã từng active, yêu cầu reason + `clientIntent=desktop` + publication-pointer `If-Match`, tạo generation mới và không xóa lịch sử. Thiếu/sai intent trả `BAD_REQUEST` không mutation. History ETag, pointer ETag và public cache ETag là ba domain riêng.                                                                                                                                                                                                                                                                           |
| WFL-008 | Mọi transition, import apply và mutation quan trọng có audit event/request ID.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| WFL-009 | Request changes atomically cập nhật original + tạo đúng một successor khi chưa có active draft; response trả `originalRevisionId`, `draftRevisionId`, `supersedesRevisionId`. Nếu đã có draft, toàn command fail không đổi dữ liệu.                                                                                                                                                                                                                                                                                                                                       |
| WFL-010 | Revision diff đồng bộ trả summary và feature-level cursor page tối đa 25 entry, gồm added/removed/modified geometry, circle radius, public properties và redacted-change marker. Query có feature/vertex bound và trả `DIFF_TOO_LARGE` thay vì chạy không giới hạn.                                                                                                                                                                                                                                                                                                       |
| WFL-011 | Attachment diff báo explicit `ATTACHMENT_CONTRACT_PENDING` tới khi backend #29 có canonical versioned binding; không suy ra từ JSON properties hoặc dùng empty array làm bằng chứng không đổi.                                                                                                                                                                                                                                                                                                                                                                            |
| WFL-012 | Checkpoint default-off của durable publication có transactional queued job + outbox, deterministic Bull dispatch/reconciliation, UUID-keyset batch checkpoint chỉ chứa public allowlist, measured feature progress, lease/heartbeat recovery, failure an toàn về `approved`, và final pointer switch nguyên tử/idempotent. Khi bật explicit, kể cả production, admission bắt buộc `clientIntent=desktop`; mọi default vẫn false. Local exact-SHA production activation được review: GO; release tổng thể vẫn NO-GO và backend #30/frontend #19 tiếp tục Open/In Progress. |

### 7.6 Public data

| ID      | Yêu cầu                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PUB-001 | Catalog/GeoJSON/detail/search chỉ đọc active publication snapshot; MVT generation-addressed được đọc đúng snapshot từng publish. Một canonical public-field allowlist dùng chung cho builder và mọi serializer chỉ nhận `public && !sensitive` với type scalar an toàn; image/attachment/type mới bị fail-closed tới khi có association serializer. Draft/review/private/raw object key không được xuất hiện. |
| PUB-002 | Catalog trả cấu hình render, schema public, generation và bounds.                                                                                                                                                                                                                                                                                                                                             |
| PUB-003 | GeoJSON yêu cầu bbox hoặc giới hạn hợp lý; response lớn chuyển sang MVT.                                                                                                                                                                                                                                                                                                                                      |
| PUB-004 | MVT dùng source layer ổn định, hỗ trợ gzip/brotli qua proxy và cache immutable theo generation; public ETag dựa trên snapshot ID + generation/path, không lộ internal checksum phụ thuộc private data.                                                                                                                                                                                                        |
| PUB-005 | Feature detail có ETag; public endpoint hỗ trợ `If-None-Match → 304`.                                                                                                                                                                                                                                                                                                                                         |
| PUB-006 | Filter chỉ dùng field `filterable`; sort chỉ dùng field `sortable`; server giới hạn số filter và độ phức tạp.                                                                                                                                                                                                                                                                                                 |
| PUB-007 | Catalog public trả `snapshotId`, `revisionId`, `generation`, `sourceKind`, URL GeoJSON/tile, MVT source layer, min/max zoom, cluster, popup/filter/search capabilities và group/order.                                                                                                                                                                                                                        |
| PUB-008 | MVT generation-addressed dùng `/public/tiles/{slug}/{generation}/{z}/{x}/{y}.pbf`, trả đúng snapshot bất biến; tile rỗng trả HTTP 200 với MVT rỗng hợp lệ.                                                                                                                                                                                                                                                    |
| PUB-009 | Public API là supported-client-only cho DanangMap frontend trong MVP; CORS/origin allowlist không phải cam kết kiểm soát truy cập hay cơ chế auth.                                                                                                                                                                                                                                                            |

### 7.7 Tìm kiếm kết hợp và Geo Service

Public search PHẢI trả cùng một DTO cho:

1. feature nội bộ từ active snapshot;
2. địa điểm bên ngoài từ Geo Service.

MVP dùng autocomplete/text search/details của Geo Service. Reverse/forward geocoding, nearby/find-place và directions được đặt sau MVP; khi triển khai vẫn phải đi qua adapter này, không gọi Mapbox Geocoding/Directions.

Các endpoint upstream đã ghi nhận:

- `GET /api/v1/geoservice/geocoder:geocode` — đúng một trong `address | latlng | place_id`;
- `GET /api/v1/geoservice/place:autocomplete` — `input`, tùy chọn `location`, `radius`;
- `GET /api/v1/geoservice/place:details`;
- `GET /api/v1/geoservice/place:textsearch`;
- `GET /api/v1/geoservice/place:nearbysearch`;
- `GET /api/v1/geoservice/place:findplacefromtext`;
- `GET /api/v1/geoservice/direction:directions`.

OpenAPI nguồn mô tả response là generic object và không khai báo security. Vì vậy:

- adapter dùng `GEO_SERVICE_BASE_URL` từ environment, không hard-code URL/credential;
- chỉ allowlist các path Geo Service nêu trên; không sao chép hay proxy user/cache/crawler endpoint không liên quan;
- connect timeout mục tiêu 2 giây, total timeout 5 giây; tối đa một retry có exponential backoff + jitter cho GET idempotent;
- circuit breaker mở khi ≥50% lỗi trong cửa sổ tối thiểu 20 request, thử lại sau 30 giây; các ngưỡng là config có giới hạn an toàn;
- validate kích thước, content type và schema runtime trước normalize; fixture contract bắt buộc trước production vì OpenAPI chưa đủ schema;
- nếu upstream search hỏng, public search trả kết quả internal với `meta.partial=true` và warning; không biến lỗi phụ thành mất toàn bộ search;
- cache ngắn theo normalized query; không cache dữ liệu nhạy cảm;
- log chỉ duration/status/correlation ID, không log query có thể chứa số điện thoại hoặc địa chỉ đầy đủ ở mức info;
- TLS và egress allowlist bắt buộc ngoài mạng nội bộ tin cậy; nếu upstream bổ sung auth, secret chỉ ở server environment và không xuất hiện trong tài liệu/response.

Kết quả internal có `position`: Point dùng chính tọa độ; line có midpoint phù hợp; polygon/multipolygon dùng `ST_PointOnSurface` để bảo đảm điểm focus nằm trên bề mặt. MVP Geo Service chỉ dùng autocomplete, text search và details; geocode, nearby, find-place và directions được defer.

## 8. API behavior chung

- Prefix `/api/v1`; JSON dùng camelCase; thời gian ISO 8601 UTC.
- Request ID từ `X-Request-Id` hợp lệ hoặc server sinh mới; luôn trả `X-Request-Id`.
- Error envelope ổn định gồm `code`, `message`, `details`, `requestId`, `timestamp`.
- List admin dùng cursor pagination; không dùng offset cho dataset có thay đổi.
- Bbox theo thứ tự `minLng,minLat,maxLng,maxLat` và nằm trong [-180..180], [-90..90].
- `ETag` là opaque; client không diễn giải. `If-Match` bắt buộc với update/xóa/versioned batch.
- Idempotency key bắt buộc cho invite/import apply/publish và client mutation retry.
- Health endpoints không version hóa: `/health/live` và `/health/ready`; các endpoint nghiệp vụ dùng `/api/v1`.
- API không trả TypeORM entity trực tiếp; DTO qua serializer allowlist.

## 9. Yêu cầu phi chức năng

### 9.1 Hiệu năng và quy mô

- Public catalog/detail cached; mục tiêu p95 ≤300 ms khi cache hit và ≤800 ms khi DB hit ở tải danh định, không tính mạng client.
- Admin CRUD p95 ≤800 ms với draft vừa; job dài phải trả 202 trong ≤1 giây.
- Search internal p95 ≤500 ms; combined p95 mục tiêu ≤2 giây và được phép partial khi Geo Service chậm.
- Tile generation được cache theo snapshot generation; không generate cùng tile đồng thời nhiều lần.
- Query luôn có limit; GeoJSON response mặc định tối đa 5.000 feature hoặc 10 MiB trước nén, vượt ngưỡng trả lỗi hướng dẫn dùng MVT/thu hẹp bbox.
- Worker concurrency và Postgres pool phải config theo tài nguyên Coolify, không đặt vô hạn.

### 9.2 Tính nhất quán

- PostgreSQL là nguồn sự thật cho user, workflow, revision và job state.
- Redis/MinIO mất tạm thời không được làm publication pointer sai.
- Publish/rollback pointer là atomic.
- Job retry phải idempotent; at-least-once delivery không tạo duplicate.

### 9.3 Bảo mật

- Validate DTO với whitelist/forbid unknown; giới hạn body, query length, nesting và array length.
- CORS chỉ cho origin frontend DanangMap được cấu hình; credentials bật chỉ với origin cụ thể.
- Helmet/CSP, HSTS ở ingress, CSRF, rate limit và brute-force protection.
- SQL dùng bind parameter; dynamic field/filter phải map từ allowlist schema, không chèn identifier trực tiếp.
- Presigned URL TTL ngắn, scoped object key, content length và MIME; object mặc định private.
- Attachment download public chỉ qua endpoint kiểm tra field public/snapshot.
- Audit log append-only; không lưu password, session token, MFA secret, invite token, recovery code hoặc credential upstream.
- Dependency/container scan và secret scan là required CI checks.

### 9.4 Quan sát và vận hành

- Structured JSON logs có service, version, environment, request/job ID, actor ID, latency, outcome.
- Metrics tối thiểu: request rate/error/latency, DB pool, Redis, queue depth/age/failure, import counts, publication duration, Geo Service breaker/latency, tile cache hit.
- `/health/live` không gọi dependency; `/health/ready` kiểm tra Postgres, Redis và migration version. Geo Service không làm API unready vì search có degraded mode.
- Graceful shutdown: ngừng nhận request/job mới, hoàn tất transaction đang chạy trong timeout, đóng pool.

## 10. Validation geometry và dữ liệu

| Trường hợp                         | Hành vi                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| Sai SRID/CRS không xác định        | Error, không đoán                                            |
| Polygon self-intersection          | Error hoặc warning + preview repair; không âm thầm sửa       |
| Feature ngoài vùng Đà Nẵng         | Warning mặc định; policy layer có thể nâng thành error       |
| Circle thiếu/âm/0 `radius_m`       | Error                                                        |
| Geometry không đúng mode           | Error                                                        |
| Mixed + GeometryCollection         | Error                                                        |
| Properties có key ngoài schema     | Error ở mutation; import có thể map/bỏ theo lựa chọn rõ ràng |
| Field required thiếu               | Error                                                        |
| Field private                      | Lưu admin được; loại bỏ khỏi public snapshot                 |
| Attachment chưa finalize/scan fail | Không được bind/publish                                      |

## 11. Trạng thái và chuyển đổi

### 11.1 Revision

```text
draft ──submit──► in_review ──approve──► approved ──publish──► publishing ──success──► published
                       │                      ▲                    │
                       └──request changes──► changes_requested    └──────failure───────┘
                                                  │
                                                  └──creates──► successor draft
```

Chỉ `draft` cho phép edit/import. Submitted revision, `changes_requested` và `published` đều bất biến. Successor draft lưu `supersedesRevisionId`; một thay đổi sau publish cũng tạo draft mới.

### 11.2 Import job

```text
uploaded → inspecting → mapping_required → validating → ready
    └──────────────► failed             ready → applying → completed
                                      applying → failed/rolled_back
```

Cancel hợp lệ ở `uploaded|inspecting|mapping_required|validating|ready`.

### 11.3 Publication execution

Đường mặc định hiện tại là synchronous terminal-only:

```text
approved ── one HTTP transaction ──► published + active pointer switched
         └── any failure ──────────► approved; pointer/success snapshot/audit unchanged
```

Frontend hiển thị indeterminate trong lúc POST đang chạy. Publication history/detail chỉ trả `progress=100` sau commit; row không có measured progress trả `null`, không gán 50% theo phase.

Đường durable thử nghiệm sau đây chỉ hoạt động khi `ASYNC_PUBLICATION_ENABLED=true`:

```text
approved ── transaction ──► publishing + queued job + pending outbox
                                      └── deterministic Bull dispatch/reconciliation
                                                 │
                                                 ▼
                                  preparing → scanning_features → switching
                                      measured UUID-keyset batches       │
                                                                        ▼
                                     succeeded + new immutable snapshot + pointer
```

Job row được commit trước queue work; Postgres là source of truth và Redis loss được reconcile bằng deterministic job ID. PostgreSQL `attempts/available_at` sở hữu retry/backoff capped; Bull chỉ giao từng attempt một, và reconciliation thay delayed transport cũ khi DB đã due để queue delay không vượt lịch durable. Reconciliation dùng cursor/index `(available_at,created_at,id)` để delayed retry không bị đói dưới tải liên tục. Builder và toàn bộ public serializer dùng cùng canonical public-field allowlist, persist batch UUID-keyset, đếm feature/vertex thật, resume từ checkpoint và không ghi private/sensitive/image/attachment property. Lease hết hạn được requeue; actor/role/SoD/fingerprint/base pointer được kiểm tra lại trước build và final transaction. Detail/list trả ETag/304, cursor bounded và failure redacted. Readiness theo dõi riêng dispatcher sweep, recovery sweep, processor heartbeat và error của từng component để activation không giả làm recovery heartbeat và success của component này không xóa lỗi component kia. Pointer/public ETag giữ nguyên đến final transaction; duplicate delivery và crash sau commit không tạo generation thứ hai. Activation harness dùng fixture riêng generation 1 + approved successor đúng 3 feature, filesystem nonce protocol, test-only advisory barrier sau batch 1, `SIGKILL`, lease-expiry recovery và exact atomic terminal counts; browser không có Docker socket/test endpoint. Local production activation tại exact backend `2d4675ec2385abf55fa23ad26914e037456f14cd` + frontend `6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8` đã được independent artifact review chấp nhận: hai fresh-volume run có 18/18 Playwright invocation pass, zero failed/skipped/flaky, production API/canonical worker dùng trusted STARTTLS, terminal attempt 2/recovered lease 1/generation 1→2 và cleanup 0/0/0. Cờ vẫn mặc định false. Evidence chỉ thuộc exact SHA đã chạy, không thuộc docs-only descendant; release tổng thể vẫn NO-GO vì remote CI thiếu `CROSS_REPO_READ_TOKEN`, attachment/a11y/Mapbox/deploy/no-backup blockers và PR/issues còn Draft/Open.

## 12. Ma trận kiểm thử bắt buộc

### 12.1 Unit và integration

| Nhóm              | Ca tối thiểu                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth              | Argon2 verify, MFA TOTP/recovery, expiry, revoke gồm caller, old-cookie 401, CSRF, lockout                                                                                                                                                               |
| Account lifecycle | Invite inspect/accept/replay; must-change guard; password change rotation/concurrent receipt; reset generic 202/body-only token/expiry/concurrent replay; recovery-code regenerate; admin MFA reset/re-enroll; user import inspect/validate/apply/report |
| RBAC              | Mỗi route có allow và deny; System Admin không bypass workflow                                                                                                                                                                                           |
| Separation        | self-review, editor-as-publisher, reviewer-as-publisher và editor/importer đổi role rồi publish/rollback đều bị chặn; zero domain mutation                                                                                                               |
| Geometry          | 6 geometry type, Point-only circle, invalid polygon, wrong SRID, GeometryCollection, 100.000 vertex và 64 KiB property boundaries                                                                                                                        |
| Schema            | required/type/enum/private/searchable/filterable và migration impact                                                                                                                                                                                     |
| Sync              | retry cùng mutation, stale ETag, conflict, cursor expired, server UUID mapping                                                                                                                                                                           |
| Import            | 4 format + `.json` GeoJSON sniff, 3 mode, exact 25 MiB, 100.000 record, 2.000.000 vertex, 250 MiB expanded, XLSX sheet/column limits, 20.000 DB issues, skip-invalid on/off, duplicate/retry/cancel                                                      |
| Workflow          | mọi transition hợp lệ/không hợp lệ; synchronous publish chỉ indeterminate→terminal; feature-level diff cursor/bound/redaction/circle radius; failure publish; pointer-ETag rollback                                                                      |
| Public            | draft/private leak test, ETag/304, bbox/filter/limit, MVT source layer                                                                                                                                                                                   |
| Public contract   | Full catalog source descriptor, immutable generation tile, HTTP 200 empty MVT, feature-detail ETag, polygon `ST_PointOnSurface` search position                                                                                                          |
| Geo adapter       | timeout/retry/breaker/schema-invalid/oversized/partial search                                                                                                                                                                                            |
| Attachment        | MIME spoof, too large, unfinalized, private/public binding                                                                                                                                                                                               |

### 12.2 Docker E2E

E2E chạy với PostGIS, Redis, MinIO, API, worker và seed xác định:

1. System Admin tạo/invite/import user và user enroll MFA.
2. System Admin chạy reset password/MFA/recovery flow; manual user bị chặn trước password change; đổi password rotate current/revoke others; reset request generic `202`, token chỉ ở body; revoke-all gồm caller và old-cookie retry `401`; invite/reset concurrent replay bị từ chối và mail adapter được capture.
3. Editor tạo group/layer/schema/popup config, vẽ Point/MultiPoint/Line/MultiLine/Polygon/MultiPolygon/circle bằng payload Terra Draw-compatible.
4. Đóng tab giả lập; client mutation lưu Dexie được retry, server dedupe và trả canonical UUID; logout xóa, session expiry chỉ khóa recovery.
5. Import CSV/XLSX/GeoJSON/JSON/KML; kiểm tra dry-run, skip-invalid, upsert, resource limits và MinIO full report.
6. Upload/finalize/bind/reorder/unbind attachment và kiểm tra association versioned.
7. Editor submit; self-review bị 403; Reviewer request changes tạo successor draft; participant đổi role vẫn không được publish; revision gốc bất biến.
8. Public catalog/GeoJSON/generation-addressed MVT/detail chỉ thấy snapshot mới và không thấy field private; tile rỗng HTTP 200 hợp lệ.
9. Search combined trả internal + external normalized; polygon focus dùng `ST_PointOnSurface`; external timeout trả partial internal.
10. Rollback đổi snapshot atomically và cache generation thay đổi.

### 12.3 Acceptance matrix

| Capability   | Given                               | When                               | Then                                                                                |
| ------------ | ----------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| Autosave     | Có 10 mutation chưa ack trong Dexie | Reload và sync                     | Mỗi mutation áp dụng tối đa một lần; conflict được hiển thị, không mất local change |
| Upsert       | 3 match, 2 không match              | Apply                              | 3 update, 2 feature UUID mới, report đúng count                                     |
| Skip invalid | 100 record, 4 error                 | Apply với skip=true                | 96 record commit, 4 issue lưu; với skip=false commit 0                              |
| Publication  | Snapshot A đang active              | Build B thất bại                   | A vẫn active; public/cache không trỏ B                                              |
| Privacy      | Field `internalNote.public=false`   | Publish/search/tile/detail         | Field không xuất hiện ở mọi public surface                                          |
| Strict roles | Editor là participant               | Role sau đó đổi Reviewer/Publisher | Vẫn không được review/publish revision đó                                           |
| Geo degraded | Breaker đang open                   | Combined search                    | HTTP 200, internal results, `partial=true`, warning ổn định                         |
| Concurrency  | Hai client cùng ETag                | Cùng sửa feature                   | Một thành công; client còn lại nhận conflict, không last-write-wins                 |

## 13. Migration dữ liệu v1

- Lập manifest file nguồn, checksum SHA-256, encoding, feature count và field mapping.
- Transform lặp lại được, chạy qua cùng validation pipeline như import.
- Không dùng fallback “không match thì chọn record đầu tiên”; kết quả phải là matched, ambiguous hoặc unmatched.
- Đối soát count, bounds, geometry validity, sample thuộc tính và screenshot visual.
- Chỉ Publisher kích hoạt snapshot migrated sau sign-off; source JSON cũ giữ read-only đến hết thời gian cutover.

## 14. Deployment và cấu hình

- Docker image API/worker chạy non-root, multi-stage, cùng artifact/version.
- Coolify triển khai API, worker, frontend, PostGIS, Redis, MinIO.
- Migration là one-off release job và chỉ một instance chạy; app chỉ ready khi schema đúng version.
- Secret chỉ ở environment/secret store: database, Redis, session pepper, encryption key, MinIO, Geo Service auth nếu được bổ sung.
- Mapbox public token thuộc frontend; backend không chứa Mapbox geocoding/directions key.
- Không dùng `synchronize`, không auto-run destructive migration khi process khởi động.

## 15. Ngoài phạm vi và rủi ro được chấp nhận

### 15.1 Ngoài phạm vi MVP

- phân quyền Editor theo từng layer/đơn vị;
- sửa geometry trên mobile; mobile admin chỉ xem/review;
- chia sẻ map state bằng query string;
- satellite, terrain, 3D;
- collaborative merge/CRDT hoặc nhiều active draft/layer;
- Mapbox Geocoding/Directions;
- public developer API cho bên thứ ba;
- GeometryCollection.

### 15.2 Geo Service response chưa có schema

OpenAPI ngoài chỉ khai báo response object tổng quát. Đây là blocker trước production integration: cần fixture thực và contract schema đã version hóa. Cho đến lúc đó adapter phải fail closed với response không hợp lệ và combined search được degraded.

### 15.3 Giới hạn upsert

UUID server tạo giải quyết identity cho record mới nhưng không tự suy ra record cũ. Upsert chính xác chỉ dùng `feature_id` hoặc cặp `(external_source, external_id)`. Không được matching mơ hồ bằng arbitrary property, tên hoặc địa chỉ. Nếu không có match key, hệ thống xử lý như append, tạo UUID mới và cảnh báo trước apply.

### 15.4 Không có backup

Theo quyết định hiện tại, backup/restore không thuộc phạm vi. Rủi ro được chấp nhận: mất volume PostGIS/MinIO có thể làm mất dữ liệu, attachment và lịch sử không thể phục hồi; Redis có thể dựng lại nhưng session/job tạm thời mất. Hệ thống vẫn phải:

- dùng persistent volume và không xóa dữ liệu khi redeploy;
- có migration rollback/runbook ở mức ứng dụng;
- hiển thị cảnh báo vận hành trong release checklist.

Quyết định này PHẢI được rà soát lại trước production go-live; nó không được hiểu là backend đảm bảo khả năng khôi phục dữ liệu.

## 16. Definition of Done cho backend

- Migration up/down hoặc forward-fix đã review và chạy trên database trống.
- OpenAPI và typed client không bị drift.
- Lint, typecheck, unit, integration, security scan và Docker E2E pass.
- Route có DTO validation, auth/RBAC allow+deny test, audit và error code ổn định.
- Query plan/index được kiểm tra cho public bbox/search/MVT quan trọng.
- Không secret, raw credential hoặc dữ liệu cá nhân nhạy cảm trong log/fixture.
- Tài liệu `SRS.md` và `API-CONTRACT.md` được cập nhật cùng thay đổi hợp đồng.
