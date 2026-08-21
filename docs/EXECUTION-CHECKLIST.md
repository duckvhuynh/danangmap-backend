# DanangMap v2 — Execution Checklist

> Trạng thái: `ACTIVE`
> Cập nhật: 2026-08-21
> Phạm vi gần nhất: design gate, vertical slice public map, controlled publication path, Docker E2E
> Nguồn yêu cầu: `PRD.md`, `SRS.md`, `API-CONTRACT.md`, `PLANS.md`, `../../danangmap-frontend/docs/DESIGN.md`

## 1. Kết quả cần chứng minh

Kế hoạch triển khai đầu tiên không được coi là hoàn tất chỉ vì frontend hoặc backend chạy riêng. Hai vertical slice dưới đây phải chứng minh đường đi xuyên hệ thống bằng contract thật và dữ liệu seed xác định:

1. **Published layer read path:** mở `/` → tải catalog từ DanangMap API → bật một layer đã publish → tải GeoJSON theo bbox → chọn feature → xem detail chỉ gồm field public → chuyển Street/Light → dùng list alternative khi không thao tác canvas.
2. **Controlled publication path:** Editor sửa một draft → submit → Reviewer khác tác giả approve → Publisher chưa từng tham gia publish → active snapshot đổi nguyên tử → public map đọc generation mới. Các self-review, participant-publish và System Admin bypass phải bị từ chối.

Slice đầu tiên chỉ cần fixture Point và Polygon để chứng minh kiến trúc. Nó không được dùng để tuyên bố đã hoàn tất toàn bộ geometry, import, attachment, MFA, migration v1 hoặc hardening; các capability đó vẫn theo backlog 169 ID trong `PLANS.md`.

## 2. Trạng thái cổng hiện tại

| Gate | Trạng thái | Bằng chứng bắt buộc để chuyển trạng thái |
| --- | --- | --- |
| D0 — PO chọn visual | `APPROVED` | PO đã approve Direction 1 refined ngày 2026-08-21 |
| D1 — Derived design artifacts | `COMPLETE` | Ba artifact commit tại frontend `2d35ec5`; badge/CTA visual QA follow-up hoàn tất tại `0899ebd` |
| D2 — Design source of truth | `COMPLETE` | `DESIGN.md` đã ghi decision/date/artifact, Tabler Icons, blue tokens, Google Maps-like radius/shadow và trạng thái `SELECTED_READY_TO_SCAFFOLD` |
| D3 — UI scaffold unlocked | `UNLOCKED` | Selection/source-of-truth gate đạt tại `2d35ec5`; visual QA hoàn tất tại `0899ebd`; commit design phải là ancestor của commit UI đầu tiên |
| V1 — Published read slice | `IN_PROGRESS` | Frontend public source và backend foundation đang triển khai; contract, published read API và Docker E2E chưa cùng pass |
| V2 — Controlled publication slice | `IN_PROGRESS` | Backend workflow/admin shell source đã bắt đầu; ba actor, deny matrix, atomic pointer và public generation assertions chưa đủ evidence |

Frontend gate issue `#1` có đủ evidence để đóng tại `2d35ec5` + `0899ebd`. Backend M0 issue `#1` vẫn mở cho tới khi các exit criteria M0 còn lại trong `PLANS.md` có bằng chứng.

## 3. Backlog integrity

Kiểm tra tự động trên bảng §5 của `PLANS.md` ngày 2026-08-21:

| Nhóm | Số ID |
| --- | ---: |
| Cross-product `C-*` | 17 |
| Backend `B-*` | 68 |
| Frontend `F-*` | 47 |
| Data migration `D-*` | 10 |
| Quality/release `Q-*` | 27 |
| **Tổng** | **169** |

Kết quả: `0` ID trùng, `0` dependency tham chiếu thiếu, `0` cycle, toàn bộ `169/169` node topological-sort được. Kiểm tra lại sau mọi thay đổi backlog bằng một script CI hoặc review tương đương; không sửa dependency chỉ để làm graph xanh nếu quan hệ nghiệp vụ chưa đúng.

## 4. Work packages thực thi

Mỗi task dưới đây được giới hạn mục tiêu khoảng 30–60 phút. Nếu vượt quá một giờ do phát hiện mới, tách task và cập nhật dependency trước khi tiếp tục.

### 4.1 Gate và contract

- [x] **VS-001 — Frontend/Design:** Commit `direction-1-refined.png` với checksum và ghi PO decision. Mapping: `C-006`.
  - Acceptance: đúng một hướng được chọn; ba hướng gốc vẫn giữ làm lịch sử; chưa scaffold UI.
- [x] **VS-002 — Frontend/Design:** Derive public mobile từ đúng Direction 1 refined. Mapping: `C-016`.
  - Acceptance: một bottom sheet active, search/touch target/safe area và map visibility được thể hiện.
- [x] **VS-003 — Frontend/Design:** Derive admin editor desktop theo geojson.io interaction model. Mapping: `C-016`.
  - Acceptance: top bar, draw rail, feature explorer, map, inspector và resizable data panel được thể hiện.
- [x] **VS-004 — Frontend/Design:** Derive admin review mobile. Mapping: `C-016`.
  - Acceptance: chỉ view/comment/approve/request changes; không có draw/import/schema/publish/rollback.
- [x] **VS-005 — Frontend/Design:** Khóa `DESIGN.md` và design QA. Mapping: `C-016`.
  - Acceptance: Tabler Icons; primary `#1A73E8` cùng tint semantic; control radius/elevation kiểu Google Maps web; không gradient/glass; trạng thái `SELECTED_READY_TO_SCAFFOLD`.
- [ ] **VS-006 — Backend/API:** Chọn operation IDs và schemas tối thiểu cho catalog, GeoJSON, detail, auth principal, batch mutation và workflow command. Mapping: `C-003`, `B-055`.
  - Acceptance: không đổi envelope, ETag, idempotency, CSRF, privacy hoặc generation semantics đã baseline.

### 4.2 Repository và Docker foundation

- [x] **VS-007 — Backend:** Scaffold NestJS API/worker workspace và fail-fast config. Mapping: `B-001`. Evidence: backend `1767787`.
  - Acceptance: install/build/unit command dùng lockfile và chạy độc lập cho API/worker.
- [x] **VS-008 — Backend:** Tạo TypeORM datasource PostGIS với `synchronize=false`. Mapping: `B-003`. Evidence: fresh Docker migration + PostGIS integration tại `1767787`.
  - Acceptance: migration baseline chạy trên database trống; PostGIS extension được xác nhận.
- [ ] **VS-009 — Backend:** Kết nối Redis/BullMQ và worker lifecycle tối thiểu. Mapping: `B-004`.
  - Acceptance: enqueue/consume fixture job; graceful shutdown không nhận job mới.
- [ ] **VS-010 — Backend:** Tạo MinIO adapter và bucket initializer contract. Mapping: `B-005`.
  - Acceptance: object key do server kiểm soát; không public bucket; probe/test xanh.
- [ ] **VS-011 — Backend:** Request ID, problem envelope và structured redacted log. Mapping: `B-007`.
  - Acceptance: success/error có request ID; fixture secret/private value không xuất hiện log.
- [x] **VS-012 — Backend:** Liveness/readiness và migration-version check. Mapping: `B-006`. Evidence: Docker live/ready HTTP 200 tại `1767787`.
  - Acceptance: liveness không gọi dependency; readiness fail khi DB/Redis/migration chưa sẵn sàng.
- [x] **VS-013 — Frontend:** Thiết lập Next.js non-UI tooling. Mapping: `F-001`. Evidence: frontend `fb73d95`.
  - Acceptance: lint, typecheck, unit và production build chạy; task này không tạo production screen trước D3.
- [ ] **VS-014 — QA/Ops:** Tạo compose E2E skeleton với network, healthcheck và isolated project naming. Mapping: `Q-008`.
  - Acceptance: PostGIS, Redis, MinIO/init, mail capture, scanner/mock placeholders có dependency rõ; volume của developer không được dùng.

### 4.3 Published layer read path

- [ ] **VS-015 — Backend:** Migration tối thiểu cho layer/group/revision/field. Mapping: `B-018`, `B-019`.
  - Acceptance: constraints/index/status/field privacy đúng contract; fresh migration test xanh.
- [ ] **VS-016 — Backend:** Migration feature/version/revision link và spatial index. Mapping: `B-020`.
  - Acceptance: EPSG:4326, immutable version link, GIST index và private properties fixture.
- [ ] **VS-017 — Backend:** Migration publication snapshot/active pointer. Mapping: `B-021`.
  - Acceptance: một active pointer mỗi layer; generation/snapshot immutable constraints.
- [ ] **VS-018 — Backend:** Seed deterministic một group, một mixed-capable layer, Point/Polygon và một field private. Mapping: `B-056`.
  - Acceptance: chạy lại không duplicate; không dùng credential production.
- [ ] **VS-019 — Backend:** Public catalog projection endpoint. Mapping: `B-034`, `B-067`.
  - Acceptance: group/order/default visibility/source capability/popup/generation có ETag; draft/private field vắng mặt.
- [ ] **VS-020 — Backend:** GeoJSON bbox endpoint và feature detail ETag. Mapping: `B-035`, `B-062`.
  - Acceptance: bbox required theo policy; limit; `If-None-Match → 304`; query dùng spatial index.
- [ ] **VS-021 — Backend:** Public leakage integration fixture. Mapping: `B-041`, `Q-006`.
  - Acceptance: private key không xuất hiện trong catalog/GeoJSON/detail hoặc cache serialization.
- [ ] **VS-022 — Backend:** Sinh OpenAPI và pin artifact cho frontend. Mapping: `B-055`, `Q-007`.
  - Acceptance: stable operation IDs; lint xanh; generated-client command reproducible.
- [ ] **VS-023 — Frontend:** Scaffold selected theme/app shells sau D3. Mapping: `F-002`, `F-003`.
  - Acceptance: semantic tokens, Tabler-only icons, no raw blue trong component, radius/shadow đúng `DESIGN.md`.
- [ ] **VS-024 — Frontend:** Generated client boundary và cookie/CSRF-ready fetch wrapper. Mapping: `F-004`, `F-047`.
  - Acceptance: frontend không gọi handwritten DTO endpoint; CI phát hiện generated client stale.
- [ ] **VS-025 — Frontend:** Mapbox runtime lifecycle và Street/Light switch. Mapping: `F-005`, `F-006`, `F-007`.
  - Acceptance: init/cleanup một lần; rehydrate custom layer sau style load; không có Satellite hoặc URL map-state.
- [ ] **VS-026 — Frontend:** Catalog/layer toggle và Point/Polygon fixture render. Mapping: `F-008`, `F-009`, `F-010`.
  - Acceptance: data từ API; loading/empty/layer-error độc lập; source/layer ID deterministic.
- [ ] **VS-027 — Frontend:** Feature detail và viewport list alternative. Mapping: `F-012`, `F-015`.
  - Acceptance: schema-driven public fields; private/unknown field không render; keyboard flow hoạt động ngoài canvas.
- [ ] **VS-028 — Frontend:** Responsive floating controls từ derived artifacts. Mapping: `F-016`, `F-017`, `F-018`.
  - Acceptance: desktop floating panels/mobile single sheet; 44 px target; no query/hash state.

### 4.4 Controlled publication path

- [ ] **VS-029 — Backend:** User/role/session migration và deterministic Editor/Reviewer/Publisher/System Admin seed. Mapping: `B-008`, `B-056`.
  - Acceptance: một primary role; session revoke fields; seed idempotent.
- [ ] **VS-030 — Backend:** RBAC guard và separation policy predicates. Mapping: `B-016`, `B-017`.
  - Acceptance: allow/deny tests gồm self-review, prior participant publish và System Admin bypass.
- [ ] **VS-031 — Backend:** Draft create, feature mutation và optimistic ETag. Mapping: `B-026`, `B-027`.
  - Acceptance: server UUID; stale write fail; audit participant recorded.
- [ ] **VS-032 — Backend:** Validate/submit và approve commands. Mapping: `B-028`, `B-029`, `B-030`.
  - Acceptance: submitted revision immutable; invalid/self-review bị chặn.
- [ ] **VS-033 — Backend:** Snapshot builder và atomic pointer switch. Mapping: `B-031`, `B-032`.
  - Acceptance: private field stripped; build failure giữ snapshot cũ; success tăng generation và invalidate cache sau commit.
- [ ] **VS-034 — Frontend:** Minimal desktop editor for seeded properties/geometry save and submit. Mapping: `F-020`, `F-027`, `F-029`, `F-032`.
  - Acceptance: server/local state được phân biệt; mobile capability gate không render mutation tools.
- [ ] **VS-035 — Frontend:** Review/approve và publish progress surfaces. Mapping: `F-040`, `F-041`, `F-042`.
  - Acceptance: role/action visibility, backend deny state và three-actor happy path rõ; publish desktop-only.

### 4.5 Docker E2E và evidence

- [ ] **VS-036 — QA/Ops:** Hoàn thiện API/worker/frontend multi-stage non-root images. Mapping: `B-002`, `Q-008`.
  - Acceptance: reproducible lockfile build; runtime container non-root; healthcheck có timeout.
- [x] **VS-037 — QA/Ops:** Fresh DB migrate/seed test. Mapping: `Q-009`. Evidence: clean volumes, migration/seed exit 0 và 4 PostGIS integration tests tại `1767787`.
  - Acceptance: isolated empty volumes; không cần thao tác thủ công ngoài documented entrypoint.
- [ ] **VS-038 — QA/Frontend:** Playwright published read path. Mapping: `Q-011`.
  - Acceptance: `/` direct map, catalog, toggle, Point/Polygon, detail, Street/Light, list, mobile sheet, no URL state.
- [ ] **VS-039 — QA/Cross-repo:** Playwright controlled publication path. Mapping: `Q-005`, `Q-015`.
  - Acceptance: three actors pass; self-review/participant-publish/admin-bypass deny; public generation chỉ đổi sau publish success.
- [ ] **VS-040 — QA/Cross-repo:** Failure-path assertions và artifact capture.
  - Acceptance: PostGIS unavailable readiness fail; API problem envelope; public partial layer failure; publication build fail giữ snapshot; screenshots/traces lưu khi test fail.
- [ ] **VS-041 — QA/Cross-repo:** Re-run Docker E2E từ môi trường sạch.
  - Acceptance: hai run liên tiếp pass, seed không duplicate, không dùng volume/data developer, teardown chỉ xóa volume mang project name E2E.

Lệnh chuẩn dự kiến sau khi compose được triển khai:

```powershell
docker compose -f compose.e2e.yml --project-name danangmap-e2e up --build --abort-on-container-exit --exit-code-from e2e e2e
docker compose -f compose.e2e.yml --project-name danangmap-e2e down --volumes --remove-orphans
```

Nếu tên service/script thực tế khác, cập nhật tài liệu và CI cùng commit; không duy trì một lệnh tài liệu không chạy được.

## 5. Commit checkpoints

Không trộn hai repository trong một commit. Trước mỗi commit phải chạy `git status --short`, stage đúng path sở hữu và ghi test evidence trong commit/PR description.

| Thứ tự | Repo | Commit intent | Gate tối thiểu |
| ---: | --- | --- | --- |
| 1 | Frontend | `docs: lock approved danangmap design direction` | VS-001..VS-005; D3 mở |
| 2 | Backend | `docs: add executable delivery checklist` | Backlog audit 169/169 |
| 3 | Backend | `chore: scaffold api worker and docker foundation` | VS-007..VS-012, lint/typecheck/unit/build |
| 4 | Frontend | `chore: scaffold next tooling and selected ui foundation` | VS-013, VS-023..VS-024; design commit là ancestor |
| 5 | Backend | `feat: expose published layer vertical slice` | VS-015..VS-022, PostGIS integration |
| 6 | Frontend | `feat: render published layer map vertical slice` | VS-025..VS-028, component/Playwright targeted tests |
| 7 | Backend | `feat: enforce controlled publication vertical slice` | VS-029..VS-033, RBAC deny + atomicity tests |
| 8 | Frontend | `feat: add controlled publication workflow surfaces` | VS-034..VS-035, role/mobile gates |
| 9 | Backend | `test: run cross-repo docker e2e vertical slices` | VS-036..VS-041 pass twice from clean state |

Không đóng milestone issue chỉ từ commit tồn tại. Issue chỉ được chuyển `Done` khi toàn bộ exit criteria milestone ở `PLANS.md` đạt; vertical slice là evidence sớm, không thay thế phần backlog còn lại.

## 6. Quality gates bắt buộc

- [ ] OpenAPI lint/diff pass; generated frontend client không stale.
- [ ] TypeScript typecheck, lint, unit và production build pass ở cả hai repo.
- [x] TypeORM `synchronize=false`; fresh migration chạy trên PostGIS thật. Evidence: backend `1767787`.
- [ ] Public projection leak test có field private fixture và trả `0` leak.
- [ ] Mọi admin route trong slice có allow và deny assertion.
- [ ] ETag stale write, idempotency retry và publication failure đều có assertion.
- [ ] Public non-map controls có keyboard path; không có axe critical/serious trong flow slice.
- [ ] Frontend không gọi Geo Service hoặc Mapbox Geocoding/Directions trực tiếp.
- [ ] Dexie/session/localStorage không chứa credential; nếu Dexie chưa thuộc slice thì không tạo stub tuyên bố recovery hoàn chỉnh.
- [ ] Docker images non-root; secrets chỉ qua environment; log/fixture không chứa token thật.
- [ ] E2E core dùng mock Mapbox/Geo Service xác định; staging smoke thật là gate M8 riêng.
- [ ] No-backup accepted risk vẫn mở và phải sign-off lại trước production; snapshot không được gọi là backup.

## 7. Blocker và risk cần theo dõi

| ID | Trạng thái | Ảnh hưởng | Owner/next action |
| --- | --- | --- | --- |
| BLK-01 | Closed at `0899ebd` | Badge `v2` và visible gradient trên mobile CTA đã được loại bỏ | Giữ visual regression review trong implementation; thay đổi hướng phải qua design review mới |
| BLK-02 | Open trước production integration | Geo Service OpenAPI chỉ có generic response | Backend cần fixture response thật và versioned runtime schema; slice public map không được giả response như contract production |
| BLK-03 | Open cho cutover | Manifest authoritative dữ liệu v1 chưa có | Product/Data hoàn tất D-001..D-002 trước migration rehearsal |
| R-01 | Accepted, vẫn phải review M8 | Không có backup PostGIS/MinIO | Không chạy destructive production migration; release sign-off phải nêu giới hạn phục hồi |
| R-06 | Critical | Draft/private leak | Central projection + automated fixture là gate merge |
| R-07 | Critical | Workflow bypass | Backend deny matrix là gate merge; ẩn button frontend không đủ |

## 8. Báo cáo checkpoint

Mỗi checkpoint gửi tối thiểu:

1. commit hash từng repo và `git status --short`;
2. task ID/requirement ID hoàn tất;
3. lệnh test đã chạy và kết quả pass/fail;
4. Docker services đã thực sự chạy, không chỉ build;
5. screenshot/trace/report path cho E2E hoặc visual QA;
6. blocker mới có owner và điều kiện gỡ;
7. GitHub issue/Project status chỉ cập nhật theo bằng chứng trên.
