# DanangMap v2 — Execution Checklist

> Cập nhật: 2026-09-05. Phạm vi: delivery, bảo vệ main và staging QA.
> M7/M8 vẫn chờ quyết định tiếp theo của product owner.

## 1. Nguồn trạng thái

- [PLANS.md](PLANS.md): backlog 172 ID và acceptance criteria không thay đổi.
- [Project 3](https://github.com/users/duckvhuynh/projects/3): task status/dependency hiện hành.
- [Checkpoint 05/09](DELIVERY-STATUS-2026-09-05.md): SHA, CI, governance và giới hạn kiểm thử.
- [Checklist lưu](archive/EXECUTION-CHECKLIST-before-20260905.md): giữ toàn bộ evidence lịch sử. Không dùng các nhãn In Progress/Blocked trong bản lưu để suy ra việc còn lại.

Checkbox đã đánh dấu là slice có bằng chứng, không phải cam kết không có regression. Lỗi mới có issue riêng; không tự mở lại mọi milestone hoặc tuyên bố release hoàn tất.

## 2. Các gate hiện tại

| Gate                        | Trạng thái                     | Bằng chứng / giới hạn                                                                                                                   |
| --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| D0–D3 — Design/scaffold     | Complete                       | Frontend #1; DESIGN.md chốt Lucide ngày 04/09.                                                                                          |
| V1 — Published read         | Complete + QA follow-up        | Backend #9/#11, frontend #2/#4/#21 Done; seed geometry theo backend #54 chưa đạt.                                                       |
| V2 — Controlled publication | Complete + staging regression  | Backend #30, frontend #19/#20 Done; role browser report 04/09 đạt 11/11. Chưa chạy lại admin staging 05/09 vì không có phiên đăng nhập. |
| V3 — Four-format import     | Complete                       | Backend #5/#11 Done; Unicode/website fix 4eeee31 đã merge.                                                                              |
| C-017 — Protected main      | Complete (configuration/proof) | Owner-approved solo policy 05/09: PR + required CI, 0 approval, CODEOWNER tùy chọn; các bảo vệ khác giữ nguyên. Merge theo backend #56. |
| M7 — V1 migration           | Deferred / Todo                | Backend #6; chưa nghiệm thu migration đầy đủ.                                                                                           |
| M8 — Hardening/release      | Deferred / Todo                | Backend #7, frontend #25; không thay release sign-off bằng CI xanh.                                                                     |

## 3. Đối soát work packages

### Design, foundation và contract

- [x] VS-001..VS-006: selected/derived design, typed OpenAPI. Frontend #1, backend #8/#9.
- [x] VS-007..VS-014: API/worker, PostGIS/Redis/MinIO, redacted logs, readiness, frontend tooling và isolated Docker. Backend PR #52; main CI 33864138926.
- [x] VS-014A: issue forms, PR template, CODEOWNERS cả hai repo.
- [x] VS-014B: 21 Project fields và status/dependency được đối soát; field/view setup lịch sử giữ trong bản lưu.
- [x] VS-014C — configuration: required PR/CI, strict freshness, resolved conversations, enforce admins; cấm force-push/delete. Owner chấp thuận 0 approval và CODEOWNER review không bắt buộc ngày 05/09; checks vẫn gắn GitHub Actions app ID.
- [x] VS-014C — proof gate: ban đầu backend #57/frontend #47 báo REVIEW_REQUIRED/BLOCKED. GitHub từ chối owner tự approve; owner sau đó chấp thuận policy một maintainer. Không yêu cầu reviewer thứ hai hoặc admin bypass; chỉ merge khi required CI xanh.

### Public layer read

- [x] VS-015..VS-017: layer/schema/feature/version/spatial index/publication pointer migrations. Backend #3/#4 Done; fresh Docker CI xanh.
- [ ] VS-018: seed geometry regression. Seed idempotent nhưng Bàn Thạch tự cắt; backend #54 cần fixture hợp lệ và PostGIS ST_IsValid assertion.
- [x] VS-019..VS-022: public catalog, bounded spatial read/detail, private-field projection, generated contract. Backend #8/#9/#11; role E2E 04/09.
- [x] VS-023..VS-028: shell/theme, API wrapper, map styles/lifecycle, toggles/renderers, detail/list và responsive controls. Frontend #2/#4/#21. Mapbox URL restriction là owner-managed deployment follow-up, không còn blocker feature.

### Controlled publication và tài khoản

- [x] VS-029/VS-029A: roles và identity lifecycle API/UI; backend #31, frontend #8/#18.
- [x] VS-029B: secure bootstrap; backend #51/frontend #41. MFA là policy tùy chọn, mặc định false; tắt không xóa factor.
- [x] VS-030..VS-033: RBAC/state/participant policy, draft/ETag/idempotency, submit/approve, atomic publication. Backend #4/#11/#12/#28/#30.
- [x] VS-034..VS-035: schema/Multi editor, recovery/conflict, review/publish và mobile restriction. Frontend #19/#22/#23/#24; role report 04/09. Lifecycle fixes aad5065/92ee7e6 là evidence theo SHA riêng, chưa được coi là admin staging rerun.
- [x] VS-035A..VS-035C: attachment diff, history, durable publication, rollback/audit. Backend #29/#30, frontend #19/#20 Done; không còn attachment dependency đang chờ.

### Import và Docker/browser

- [x] IMP-001..IMP-008: bốn format, mapping/validation/atomic/skip-invalid/upsert/durable retry và browser publication path. Backend #5/#11; số run/SHA gốc giữ trong bản lưu.
- [x] VS-036..VS-037: non-root images và fresh migrate/seed execution; không đồng nghĩa seed geometry hợp lệ (#54).
- [x] VS-038: public browser slice frontend #4/#21; smoke 05/09 chỉ public read/search/toggle/detail, không thay device matrix.
- [x] VS-039: controlled publication slice có historical exact-SHA và role report 04/09; chưa admin staging rerun 05/09.
- [x] VS-040: API/publication failure và artifact capture có canonical/backend CI evidence; không đồng nghĩa mọi frontend push đều chạy release browser gate.
- [x] VS-041 — historical: hai fresh-volume exact-SHA runs đã đạt trong backend #11; không hồi tố sang SHA hiện tại.
- [ ] VS-041 — current all-source harness: backend #55 tách fault-injection khỏi canonical no-mock suite, M8 deferred. Không nới scanner hoặc xóa offline tests để đạt pass.

## 4. Quality và release boundaries

- [x] OpenAPI/generated-client, lint/typecheck/unit/build, Docker health: main CI baseline xanh.
- [x] TypeORM synchronize=false; Docker CI chạy migration/integration/HTTP E2E với PostGIS/Redis/MinIO thật.
- [x] Private-field/attachment projection, RBAC deny, stale ETag/idempotency: backend CI và role report.
- [x] Keyboard/a11y slice: frontend #19/#21; không tuyên bố toàn bộ WCAG hoặc thiết bị vật lý.
- [x] Frontend search qua DanangMap API; smoke 05/09 thấy internal/external result groups. Không gọi trực tiếp Mapbox Geocoding/Directions.
- [ ] Current-SHA release browser gate, token/secret scan: frontend #25/backend #55, M8 deferred.
- [ ] Performance/soak/security/release go-no-go: backend #7.
- [ ] Authoritative v1 manifest/transforms/reconciliation: backend #6.
- [ ] No-backup accepted risk phải ghi lại trong release sign-off; publication snapshot không phải backup.

## 5. Quy tắc cập nhật

1. Ghi SHA/git status từng repo; phân biệt branch tip với image đang deploy.
2. Gắn evidence đúng SHA/môi trường/phạm vi; không hồi tố local thành staging/CI.
3. Tạo issue cho regression mới; giữ historical dependency ở comment, Project chỉ nêu điều kiện đang hoạt động.
4. Dùng PR nhỏ và required checks xanh; review tùy chọn theo policy một maintainer được owner phê duyệt. Không direct-push main hoặc admin bypass.
5. Chỉ Done sau acceptance; thiếu phiên đăng nhập hoặc CI chưa đạt thì ghi rõ blocker và điều kiện gỡ.
