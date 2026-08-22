# DanangMap v2 — Execution Checklist

> Trạng thái: `ACTIVE`
> Cập nhật: 2026-08-22
> Phạm vi gần nhất: history/diff/rollback/audit checkpoint trên controlled publication, four-format import, Docker E2E
> Nguồn yêu cầu: `PRD.md`, `SRS.md`, `API-CONTRACT.md`, `PLANS.md`, `../../danangmap-frontend/docs/DESIGN.md`

## 1. Kết quả cần chứng minh

Kế hoạch triển khai đầu tiên không được coi là hoàn tất chỉ vì frontend hoặc backend chạy riêng. Ba vertical slice dưới đây phải chứng minh đường đi xuyên hệ thống bằng contract thật và dữ liệu seed xác định:

1. **Published layer read path:** mở `/` → tải catalog từ DanangMap API → bật một layer đã publish → tải GeoJSON theo bbox → chọn feature → xem detail chỉ gồm field public → chuyển Street/Light → dùng list alternative khi không thao tác canvas.
2. **Controlled publication path:** Editor sửa một draft → submit → Reviewer khác tác giả approve → Publisher chưa từng tham gia publish → active snapshot đổi nguyên tử → public map đọc generation mới. Các self-review, participant-publish và System Admin bypass phải bị từ chối.
3. **Four-format import path:** Editor upload CSV/XLSX/GeoJSON/KML → map → validate → chọn atomic hoặc skip-invalid → apply vào draft bằng optimistic lock/idempotency → imported feature đi qua chính controlled publication path ở trên.

Slice đầu tiên chỉ cần fixture Point và Polygon để chứng minh kiến trúc. Nó không được dùng để tuyên bố đã hoàn tất toàn bộ geometry, import, attachment, MFA, migration v1 hoặc hardening; các capability đó vẫn theo backlog 169 ID trong `PLANS.md`.

## 2. Trạng thái cổng hiện tại

| Gate | Trạng thái | Bằng chứng bắt buộc để chuyển trạng thái |
| --- | --- | --- |
| D0 — PO chọn visual | `APPROVED` | PO đã approve Direction 1 refined ngày 2026-08-21 |
| D1 — Derived design artifacts | `COMPLETE` | Ba artifact commit tại frontend `2d35ec5`; badge/CTA visual QA follow-up hoàn tất tại `0899ebd` |
| D2 — Design source of truth | `COMPLETE` | `DESIGN.md` đã ghi decision/date/artifact, Tabler Icons, blue tokens, Google Maps-like radius/shadow và trạng thái `SELECTED_READY_TO_SCAFFOLD` |
| D3 — UI scaffold unlocked | `UNLOCKED` | Selection/source-of-truth gate đạt tại `2d35ec5`; visual QA hoàn tất tại `0899ebd`; commit design phải là ancestor của commit UI đầu tiên |
| V1 — Published read slice | `IN_PROGRESS` | Backend typed public API/query policy (`7ec3bc7`, `efc1a29`) và frontend pin/consume (`aa0380b`, `3fd3e027`) riêng lẻ xanh; issue #9 đã đóng, còn cross-stack issue #11 chưa đạt |
| V2 — Controlled publication slice | `IN_PROGRESS` | Synchronous history/diff/rollback/audit checkpoint đã được chấp nhận tại backend `bb41e77da992c3bc5e2a6f439f51eeb5d2ef15d7` + frontend `244538488ecb4fd26f910c33d4a499ef23a7d040`; durable BullMQ local production activation gate tiếp tục GO tại exact backend `2d4675ec2385abf55fa23ad26914e037456f14cd` + frontend `6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8`. Backend #30/frontend #19 vẫn Open và slice còn attachment diff, regression keyboard/screen-reader, Mapbox visual QA, deploy/no-backup cùng remote CI blocker. |
| V3 — Four-format import slice | `COMPLETE` | Backend `bd5013b` chứng minh equivalence CSV/XLSX/GeoJSON/KML; frontend typed wizard `ab806d6`; real browser imported-feature submit/approve/publish/public pass hai lần tại backend `bb41e77da992c3bc5e2a6f439f51eeb5d2ef15d7` + frontend `244538488ecb4fd26f910c33d4a499ef23a7d040`. |

Frontend gate issue `#1` có đủ evidence để đóng tại `2d35ec5` + `0899ebd`. Backend M0 issue `#1` vẫn mở cho tới khi các exit criteria M0 còn lại trong `PLANS.md` có bằng chứng.

`V3 COMPLETE` chỉ đóng vertical slice IMP-008. Milestone M4 vẫn `IN_PROGRESS` cho attachment quarantine/scan/binding, Geo Service/external partial-failure và các exit criteria còn lại; trạng thái này không đóng issue M4 liên quan.

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
  - Acceptance: bbox required theo policy; limit; `If-None-Match → 304`; query dùng spatial index; circle giữ canonical `Point + radiusM`, còn MVT sinh polygonal representation theo bán kính mét.
- [ ] **VS-021 — Backend:** Public leakage integration fixture. Mapping: `B-041`, `Q-006`.
  - Acceptance: private key không xuất hiện trong catalog/GeoJSON/detail hoặc cache serialization.
- [x] **VS-022 — Backend:** Sinh OpenAPI và pin artifact cho frontend. Mapping: `B-055`, `Q-007`. Evidence: backend public/auth `7ec3bc7`, query/import `efc1a29`, admin spatial `09c4c98`; frontend exact pin `3fd3e027`; backend CI + frontend api/type checks xanh, issues `#8/#9` closed.
  - Acceptance: stable operation IDs; lint xanh; generated-client command reproducible; request DTO không sinh `Record<string, never>` và success response không sinh `content?: never` hoặc additional-properties-only generic object cho endpoint thuộc vertical slice.
- [x] **VS-023 — Frontend:** Scaffold selected theme/app shells sau D3. Mapping: `F-002`, `F-003`. Evidence: frontend `9c70b65` + implementation captures/design QA.
  - Acceptance: semantic tokens, Tabler-only icons, no raw blue trong component, radius/shadow đúng `DESIGN.md`.
- [x] **VS-024 — Frontend:** Generated client boundary và cookie/CSRF-ready fetch wrapper. Mapping: `F-004`, `F-047`. Evidence: frontend `aa0380b` + `3fd3e027`; generated operation/component types, credentials, session/CSRF, ETag/idempotency headers và stale-artifact check xanh.
  - Acceptance: frontend không gọi handwritten DTO endpoint; CI phát hiện generated client stale; public map dùng `/public/layers` + GeoJSON theo layer từ artifact đã pin, không cast để bù schema rỗng.
- [x] **VS-025 — Frontend:** Mapbox runtime lifecycle và Street/Light switch. Mapping: `F-005`, `F-006`, `F-007`. Evidence: style rehydration unit test và client boundary tại `9c70b65`; live-map visual fidelity còn chờ restricted token.
  - Acceptance: init/cleanup một lần; rehydrate custom layer sau style load; không có Satellite hoặc URL map-state.
- [ ] **VS-026 — Frontend:** Catalog/layer toggle và Point/Polygon fixture render. Mapping: `F-008`, `F-009`, `F-010`.
  - Acceptance: data từ API; loading/empty/layer-error độc lập; source/layer ID deterministic; circle từ `Point + radiusM` hiển thị đúng kích thước theo mét trên public canvas/zoom, không dùng marker 7 px cố định.
- [ ] **VS-027 — Frontend:** Feature detail và viewport list alternative. Mapping: `F-012`, `F-015`.
  - Acceptance: schema-driven public fields; private/unknown field không render; keyboard flow hoạt động ngoài canvas.
- [x] **VS-028 — Frontend:** Responsive floating controls từ derived artifacts. Mapping: `F-016`, `F-017`, `F-018`. Evidence: desktop/mobile/degraded Playwright captures tại `9c70b65`.
  - Acceptance: desktop floating panels/mobile single sheet; 44 px target; no query/hash state.

### 4.4 Controlled publication path

- [ ] **VS-029 — Backend:** User/role/session migration và deterministic Editor/Reviewer/Publisher/System Admin seed. Mapping: `B-008`, `B-056`.
  - Acceptance: một primary role; session revoke fields; seed idempotent.
- [ ] **VS-030 — Backend:** RBAC guard và separation policy predicates. Mapping: `B-016`, `B-017`. Partial evidence: draft PR backend `#13`/`6800ff6` có real HTTP role/SoD deny matrix, CI `32449796541` xanh; chưa có main-branch merge/browser evidence.
  - Acceptance: allow/deny tests gồm self-review, prior participant publish và System Admin bypass.
- [x] **VS-031 — Backend:** Draft create, feature mutation và optimistic ETag. Mapping: `B-026`, `B-027`. Evidence: spatial core + real domain replay tests through backend `e62c478`; create layer/feature one effect, original ETag/result survives service restart.
  - Acceptance: server UUID; stale write fail; audit participant recorded; cùng idempotency key/hash trả nguyên status/body/ETag cũ, khác hash trả `IDEMPOTENCY_KEY_REUSED`.
- [ ] **VS-032 — Backend:** Validate/submit và approve commands. Mapping: `B-028`, `B-029`, `B-030`. Partial evidence: draft PR backend `#13`/`6800ff6` chạy submit/replay/approve và self/participant deny qua HTTP thật; PR chưa merge.
  - Acceptance: submitted revision immutable; invalid/self-review bị chặn; retry tuần tự/đồng thời chỉ tạo một transition/audit qua durable DB receipt.
- [ ] **VS-033 — Backend:** Snapshot builder và atomic pointer switch. Mapping: `B-031`, `B-032`. Partial evidence: draft PR backend `#13`/`6800ff6` chứng minh one generation, private redaction và injected pointer failure giữ snapshot/generation cũ; PR chưa merge.
  - Acceptance: private field stripped; build failure giữ snapshot cũ; success tăng generation và invalidate cache sau commit; concurrent publish duplicate chỉ tạo một snapshot/generation và trả lại original result.
- [ ] **VS-034 — Frontend:** Minimal desktop editor for seeded properties/geometry save and submit. Mapping: `F-020`, `F-027`, `F-029`, `F-032`.
  - Acceptance: server/local state được phân biệt; mobile capability gate không render mutation tools.
- [ ] **VS-035 — Frontend:** Review/approve và publish progress surfaces. Mapping: `F-040`, `F-041`, `F-042`.
  - Acceptance: role/action visibility, backend deny state và three-actor happy path rõ; publish desktop-only; checkpoint đồng bộ dùng indeterminate khi POST chạy rồi terminal success/problem, không hiển thị phần trăm giả.

- [x] **VS-035A — Backend:** Canonical synchronous history/diff/rollback/audit checkpoint. Mapping: `B-033`, `B-064`, `Q-005`, `Q-027`; tracking backend `#30`.
  - Evidence: backend `bb41e77da992c3bc5e2a6f439f51eeb5d2ef15d7`; OpenAPI 73 operations; unit 67, integration 40, E2E 41. Chín endpoint canonical, bounded feature-level diff, pointer ETag riêng, role-scoped immutable audit và atomic rollback có test; hai run browser thật ở VS-041 đều pass.
  - Boundary: attachment diff vẫn explicit `ATTACHMENT_CONTRACT_PENDING` tới khi canonical binding của backend #29 tồn tại; không dùng JSON properties/empty array thay thế. Backend #30 vẫn Open/In Progress cho capability deferred này và Draft PR closeout.
- [x] **VS-035B — Backend/Worker:** Durable publication-job progress. Mapping: `B-031`, `B-032`; tracking backend `#30`.
  - Acceptance: committed job row trước work, BullMQ retry/crash recovery idempotent, observable queued/building/failed, measured monotonic progress và final pointer switch nguyên tử. Không đưa vào checkpoint synchronous bằng fake `50%`.
  - Evidence: independent review chấp nhận local production activation tại exact backend `2d4675ec2385abf55fa23ad26914e037456f14cd` + frontend `6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8`. Hai manifest `2026-08-22T02-48-36.875Z-2d4675ec2385-6e6fe83f7dbf-run-1` (`6497db82ebfd8b92206cdfabd9ffa4456d650198e3501e33485a32d2d3e9516e`) và `2026-08-22T02-53-38.466Z-2d4675ec2385-6e6fe83f7dbf-run-2` (`70a04b03205b6d58160bc22f50fd2abc10b00d4b6bec646f30d9d4dc1ca70c3a`) chứng minh 18/18 pass, zero failed/skipped/flaky, production trusted STARTTLS, attempt 2/recovered lease 1/generation 1→2 và cleanup 0/0/0.
  - Boundary: mọi default vẫn false; evidence chỉ thuộc `2d4675ec...`, không thuộc docs-only descendant. Backend PR #38 còn Draft, backend #30/frontend #19 còn Open; remote CI thiếu `CROSS_REPO_READ_TOKEN`, attachment/a11y/Mapbox/deploy/no-backup blockers giữ release tổng thể NO-GO.
- [x] **VS-035C — Frontend:** Real synchronous history/diff/rollback/audit UI checkpoint. Mapping: `F-040..F-044`, `Q-015`; tracking frontend `#19`.
  - Evidence: frontend `244538488ecb4fd26f910c33d4a499ef23a7d040` pin đúng backend contract; feature cursor/exact-vs-bbox/redacted/unavailable states, indeterminate synchronous publish, pointer-ETag rollback, public ETag/generation revalidation và mobile không publish/rollback pass trong hai run VS-041.
  - Boundary: frontend #19 vẫn Open/In Progress cho attachment diff và regression keyboard/screen-reader rõ ràng; local activation evidence ở VS-035B không tuyên bố Mapbox visual QA hoặc làm Draft PR merge-ready.

### 4.5 Four-format import path

- [x] **IMP-001 — Backend:** CSV parser thực cho coordinates/WKT. Mapping: `B-043`, `B-068`. Evidence: backend `bd5013b`; Windows-1258 tiếng Việt, delimiter token, coordinates + WKT cùng đi qua validate/apply fixture thực.
  - Acceptance: delimiter/encoding/header/row number xác định; fixture nhỏ đi qua validate, không còn `mapping_skeleton`.
- [x] **IMP-002 — Backend:** XLSX values-only parser với sheet selection. Mapping: `B-044`, `B-068`. Evidence: backend `bd5013b`; selected-sheet fixture và chỉ đọc cached formula result, typed inspection trả sheet/limit.
  - Acceptance: chọn đúng một trong tối đa 10 sheet/256 cột; formula/macro không được thực thi; fixture đi qua validate.
- [x] **IMP-003 — Backend:** GeoJSON parser/normalizer. Mapping: `B-045`, `B-024`, `B-068`. Evidence: backend `efc1a29`; real-infrastructure mapping/validate/issues/apply fixtures xanh.
  - Acceptance: Feature/FeatureCollection, geometry/property/expanded limit và issue row/feature index xác định.
- [x] **IMP-004 — Backend:** KML parser an toàn. Mapping: `B-046`, `B-024`, `B-068`. Evidence: backend `bd5013b`; safe Placemark/multi parser cùng XXE, NetworkLink, depth/node guard tests.
  - Acceptance: Placemark Point/Line/Polygon/multi fixture; XXE/network/XML bomb bị từ chối; fixture đi qua validate.
- [x] **IMP-005 — Backend:** Mapping, validate và issue cursor API. Mapping: `B-047`, `B-048`. Evidence: GeoJSON path `efc1a29` mở rộng đủ bốn format tại `bd5013b`; typed XLSX sheet inspection và `feature_id|external_identity` mapping có contract/test.
  - Acceptance: `PATCH /imports/{id}/mapping`, `POST /imports/{id}:validate`, `GET /imports/{id}/issues`; state/progress monotonic; match key chỉ `feature_id|external_identity`.
- [x] **IMP-006 — Backend:** Apply atomic/skip-invalid/upsert. Mapping: `B-049`, `B-050`, `B-051`, phần idempotency của `B-052`. Evidence: GeoJSON core `efc1a29`, durable receipt `e62c478`, four-format/upsert/upload race hardening `bd5013b`; Docker 8 suites/24 tests pass.
  - Acceptance: `POST /imports/{id}:apply` dùng ETag + idempotency; false-skip commit `0`; true-skip chỉ valid; retry không duplicate; `feature_id` missing match tạo server UUID; wrong-layer/malformed ID thành deterministic issue.
- [x] **IMP-007 — Frontend:** Wizard tối thiểu upload → mapping → validate/issues → apply. Mapping: `F-036`, `F-037`, `F-038`, phần reconnect/result của `F-039`. Evidence: frontend `ab806d6` pin OpenAPI backend `bd5013b`; api/type/lint, Vitest 51/51, build, desktop CSV Playwright, Docker health 200.
  - Acceptance: bốn format chọn được; XLSX inspection/sheet, CSV encoding/delimiter, geometry/field/mode, hai upsert key, skip-invalid và terminal/error states rõ; UI không tự parse file lớn hoặc lưu binary vào Dexie; ambiguous upload retry giữ cùng request/key.
- [x] **IMP-008 — QA/Cross-repo:** Fixture equivalence và UI integration. Mapping: `Q-003`, `Q-004`, `Q-008`, `Q-015`. Evidence: backend `bd5013b` chứng minh CSV coordinates/WKT, XLSX, GeoJSON, KML cùng normalized 2 valid + 1 invalid; skip false/true/retry trên PostGIS/Redis/MinIO thật. Frontend `ab806d6` có typed wizard; real browser/API tại backend `bb41e77da992c3bc5e2a6f439f51eeb5d2ef15d7` + frontend `244538488ecb4fd26f910c33d4a499ef23a7d040` chứng minh một imported feature đi qua submit/approve/publish/public trong cả hai run fresh-volume.
  - Acceptance: bốn fixture tương đương tạo cùng normalized records/counts trong Docker; UI E2E ít nhất một format; imported record đi tiếp qua submit/approve/publish/public. Tracking: backend issue `#11`.

`cancel` và full report-download vẫn thuộc `B-048`, `B-052`, `F-038`, `F-039` và không được tuyên bố Done từ slice tối thiểu này.

### 4.6 Docker E2E và evidence

- [x] **VS-036 — QA/Ops:** Hoàn thiện API/worker/frontend multi-stage non-root images. Mapping: `B-002`, `Q-008`. Evidence: backend `1767787`, frontend `9c70b65`; images build và frontend/backend health pass.
  - Acceptance: reproducible lockfile build; runtime container non-root; healthcheck có timeout.
- [x] **VS-037 — QA/Ops:** Fresh DB migrate/seed test. Mapping: `Q-009`. Evidence: clean volumes, migration/seed exit 0 và 4 PostGIS integration tests tại `1767787`.
  - Acceptance: isolated empty volumes; không cần thao tác thủ công ngoài documented entrypoint.
- [ ] **VS-038 — QA/Frontend:** Playwright published read path. Mapping: `Q-011`.
  - Acceptance: `/` direct map, catalog, toggle, Point/Polygon, detail, Street/Light, list, mobile sheet, no URL state.
- [ ] **VS-039 — QA/Cross-repo:** Playwright controlled publication path. Mapping: `Q-005`, `Q-015`.
  - Partial evidence: exact-SHA browser runs tại backend `bb41e77da992c3bc5e2a6f439f51eeb5d2ef15d7` + frontend `244538488ecb4fd26f910c33d4a499ef23a7d040` chứng minh three actors, Editor approve deny và public generation chỉ đổi sau publish success; backend API suite bao phủ participant-publish/System Admin bypass. Còn thiếu assertion browser trực tiếp cho toàn bộ participant-publish/admin-bypass deny trước khi đánh dấu Done; tracking: backend issue `#11`.
- [ ] **VS-040 — QA/Cross-repo:** Failure-path assertions và artifact capture.
  - Acceptance: PostGIS unavailable readiness fail; API problem envelope; public partial layer failure; publication build fail giữ snapshot; screenshots/traces lưu khi test fail.
- [x] **VS-041 — QA/Cross-repo:** Re-run Docker E2E từ môi trường sạch.
  - Evidence: backend `bb41e77da992c3bc5e2a6f439f51eeb5d2ef15d7` + frontend `244538488ecb4fd26f910c33d4a499ef23a7d040`; hai run HTTPS fresh-volume liên tiếp pass 5/5 real-stack specs, không route/service mock, seed reset giữa spec và teardown không để lại project container/volume/network.
  - Local evidence: `artifacts/fullstack/2026-08-21T19-07-31.934Z-244538488ecb-run-1` và `artifacts/fullstack/2026-08-21T19-09-53.800Z-244538488ecb-run-2`. Hai thư mục bị `.gitignore` và không công khai, nhưng dùng ACL kế thừa chứ chưa strict ACL-restricted và chưa có manifest tự ràng buộc SHA/project/spec exit/checksum/residual. Hardening sau phải đưa evidence vào kho bảo vệ và sinh manifest; không hồi tố tuyên bố bằng chứng này là public hoặc cryptographically bound.

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
| 9 | Backend | `feat: validate and apply four-format spatial imports` | IMP-001..IMP-006, parser equivalence + atomicity tests |
| 10 | Frontend | `feat: connect spatial import wizard` | IMP-007, generated-client contract/component tests |
| 11 | Backend | `test: run cross-repo docker e2e vertical slices` | VS-036..VS-041 + IMP-008 pass twice from clean state |

Không đóng milestone issue chỉ từ commit tồn tại. Issue chỉ được chuyển `Done` khi toàn bộ exit criteria milestone ở `PLANS.md` đạt; vertical slice là evidence sớm, không thay thế phần backlog còn lại.

## 6. Quality gates bắt buộc

- [x] OpenAPI lint/diff pass; generated frontend client không stale. Evidence: backend `bd5013b` + CI `32448008945`; frontend pin `ab806d6` và `api:check` pass.
- [x] TypeScript typecheck, lint, unit và production build pass ở cả hai repo. Evidence: backend `1767787`, frontend `9c70b65`.
- [x] TypeORM `synchronize=false`; fresh migration chạy trên PostGIS thật. Evidence: backend `1767787`.
- [ ] Public projection leak test có field private fixture và trả `0` leak.
- [ ] Mọi admin route trong slice có allow và deny assertion.
- [ ] ETag stale write, idempotency retry và publication failure đều có assertion.
- [ ] Public non-map controls có keyboard path; không có axe critical/serious trong flow slice.
- [ ] Frontend không gọi Geo Service hoặc Mapbox Geocoding/Directions trực tiếp.
- [x] Dexie/session/localStorage không chứa credential; scoped recovery fixture tests pass tại frontend `9c70b65`. Recovery/server conflict E2E vẫn là gate riêng.
- [x] Docker images non-root; secrets chỉ qua environment; log/fixture không chứa token thật. Evidence: backend `1767787`, frontend `9c70b65`.
- [ ] E2E core dùng mock Mapbox/Geo Service xác định; staging smoke thật là gate M8 riêng.
- [ ] No-backup accepted risk vẫn mở và phải sign-off lại trước production; snapshot không được gọi là backup.

## 7. Blocker và risk cần theo dõi

| ID | Trạng thái | Ảnh hưởng | Owner/next action |
| --- | --- | --- | --- |
| BLK-01 | Closed at `0899ebd` | Badge `v2` và visible gradient trên mobile CTA đã được loại bỏ | Giữ visual regression review trong implementation; thay đổi hướng phải qua design review mới |
| BLK-02 | Open trước production integration | Geo Service OpenAPI chỉ có generic response | Backend cần fixture response thật và versioned runtime schema; slice public map không được giả response như contract production |
| BLK-03 | Open cho cutover | Manifest authoritative dữ liệu v1 chưa có | Product/Data hoàn tất D-001..D-002 trước migration rehearsal |
| BLK-04 | Open cho final visual fidelity | Chưa có URL-restricted `NEXT_PUBLIC_MAPBOX_TOKEN`; live labels/marker/polygon/Terra Draw không thể so sánh trung thực với source rasters | Ops/Product cấp public token giới hạn domain; chạy lại bốn viewport + focused map crops và cập nhật frontend `design-qa.md` |
| BLK-05 | Closed at backend `09c4c98` + frontend `3fd3e027`; issue #8 closed | Explicit admin spatial schemas, generic-only drift guard và generated-derived FE models đã có; runtime decoder chỉ còn là trust-boundary defense | Giữ stale-artifact/API checks trong CI; schema mới không quay lại generic-only body |
| BLK-06 | Closed at backend `efc1a29` + frontend `3fd3e027`; issue #9 closed | Typed public queries, bbox+limit client và >1.000 feature MVT policy đã có test/CI | Paging/cursor chỉ mở lại nếu product chọn hybrid list vượt full-GeoJSON threshold |
| BLK-07 | Open, backend issue #10 | Login có thể trả `mfaEnrollmentRequired=true` nhưng chưa có `/auth/mfa/enroll` và `/auth/mfa/enroll/confirm` | Backend hoàn tất pre-auth enrollment/recovery-code one-time và Docker HTTP lifecycle; frontend không giả luồng enrollment |
| BLK-08 | Closed at backend `e62c478` + `d5ca105`; issue #12 closed | Durable DB receipt/request-hash/original-result semantics có domain tests thực: Docker integration 6 suites/18 pass; root verification OpenAPI/typecheck/unit pass; follow-up CI `32445758290` xanh toàn bộ | Giữ receipt replay/concurrency suite trong CI; issue #11 và M4 vẫn mở cho browser deny/public-read/failure paths còn lại, attachment và external integration; V3/IMP-008 đã complete riêng |
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
