# Durable publication activation runbook

## Trạng thái an toàn hiện tại

- `ASYNC_PUBLICATION_ENABLED=false` ở schema, `.env.example` và Compose mặc định.
- Guard-removal WIP chỉ bỏ validation rejection khi production được đặt explicit
  `ASYNC_PUBLICATION_ENABLED=true`; không có cấu hình nào tự bật cờ này và production activation vẫn
  NO-GO cho đến khi review cùng hai run production-mode hoàn tất.
- Harness dùng API/worker runtime thật, PostGIS, Redis/BullMQ, MinIO, Next.js và Playwright qua
  `https://gateway`; không có route mock, service mock, test HTTP endpoint hoặc Docker socket trong
  browser.
- Chỉ `crash-worker` chạy `NODE_ENV=test` để dùng advisory barrier. Canonical worker có
  `DANANGMAP_CANONICAL_WORKER_NODE_ENV`, mặc định `development` trước activation và chỉ được đổi
  thành `production` sau commit guard riêng đã review.

## Exact-SHA inputs

```powershell
$env:DANANGMAP_BACKEND_SHA = (git rev-parse HEAD)
$env:DANANGMAP_FRONTEND_CONTEXT = "D:/path/to/danangmap-frontend"
$env:DANANGMAP_FRONTEND_SHA = (git -C $env:DANANGMAP_FRONTEND_CONTEXT rev-parse HEAD)
$env:DANANGMAP_FULLSTACK_RUNS = "2"
npm run test:fullstack:harness
```

Hai worktree phải clean và SHA phải là full lowercase SHA. Frontend phải là descendant của
`cbb31e6b7901cd30f2fca8ba81ebe2f24e7e9d7f`; harness vẫn pin exact SHA được truyền, không chạy
floating branch/tag.

## Phased protocol

Mỗi run sinh `phase/input.json` với `schemaVersion=1`, nonce ngẫu nhiên, layer/revision deterministic,
feature total `3` và generation-one pointer. Frontend chạy cùng spec bốn lần với
`DANANGMAP_DURABLE_PUBLICATION_PHASE=queue|progress|crashed|terminal`, rồi ghi file cùng tên bằng
atomic rename. Mọi output phải lặp đúng nonce, layer ID, revision ID và job ID.
Thư mục bind được truyền đúng qua `DANANGMAP_DURABLE_PUBLICATION_PHASE_DIR=/phase`. Successor chứa
nonce của run trong public feature data; baseline không được chứa nonce đó.

1. `queue`: worker chưa chạy; publish trả durable job attempt `0`; pointer/generation/snapshot giữ
   nguyên.
2. Harness giữ advisory barrier `after_batch_commit`, start `crash-worker` batch size `1`.
3. `progress`: UI/API phải thấy đúng `1/3` measured features, một persisted batch, pointer chưa đổi.
4. Harness gửi `SIGKILL`; exit code phải `137`, không OOM. Barrier được release sau khi process chết.
5. `crashed`: browser process mới recover cùng job/progress; DB vẫn có lease và pointer cũ.
6. Sau lease expiry bounded, harness start canonical worker. Recovery phải claim attempt tiếp theo,
   resume checkpoint và hoàn tất.
7. `terminal`: đúng một snapshot mới, generation `+1`, pointer=result snapshot, revision published và
   đúng một publish participant/workflow event/audit. `recovered_lease_count>=1`, `attempts>=2`.
8. Năm real-stack spec còn lại chạy với canonical worker, tổng cộng sáu file bắt buộc.

Mỗi phase reset riêng seeded auth state; reset không sửa domain/job data. Fixture Publisher không có
edit/review participation ở approved successor.

## Evidence và teardown

Mỗi run lưu local dưới `artifacts/fullstack/<timestamp>-<backend>-<frontend>-run-N/`:

- Playwright HTML/results theo phase/spec;
- JSON reporter riêng cho từng Playwright invocation; mỗi invocation phải có `passed>0`,
  `failed=0`, `skipped=0`, `flaky=0` ngoài exit code `0`;
- DB evidence seed/queue/progress/crash/lease-expired/terminal;
- crash/barrier container inspect và mandatory logs; log command lỗi/timeout làm fail run;
- Compose logs, bounded command journal, image/service labels của migrate/seed/api/worker/helper
  test/smoke/barrier/browser và fail-closed residual audit;
- `evidence.json` ràng buộc expected/actual SHA, HTTPS, duration, exit codes, invariants và SHA-256
  của mọi artifact khác;
- `evidence.json.sha256` ràng buộc manifest (manifest không tự đưa chính nó vào file inventory).

`docker compose down -v --remove-orphans` luôn chạy, kể cả failure. Harness fail nếu còn container,
network hoặc volume mang project label. Artifact có thể chứa fixture session/trace và chỉ được giữ ở
kho bảo vệ với retention ngắn; không dùng production credential.

## CI và blocker ngoài code

Cross-repository job chỉ dùng `pull_request`, checkout exact SHA với `persist-credentials=false` và
fail rõ nếu thiếu `CROSS_REPO_READ_TOKEN`. Không dùng `pull_request_target`. Secret này phải được chủ
repo cấu hình trước khi remote gate có thể xanh; local exact-SHA gate không phụ thuộc secret GitHub.
Workflow activation pin frontend reviewed SHA `6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8` từ một
job-level environment source dùng chung cho checkout và harness.

## Guard-intact pretrial đã chấp nhận

Independent audit đã chấp nhận pretrial dùng backend
`b3e12df3f7c728bf2499fc7fb90ff3a65762f3c8`, frontend
`6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8` và API/canonical worker mặc định
`development`. Hai fresh-volume run đều pass:

- `artifacts/fullstack/2026-08-22T01-54-15.498Z-b3e12df3f7c7-6e6fe83f7dbf-run-1/evidence.json`
  — SHA-256 `9f66aa554a08634657b15fc4e003befcc2dbf1b06fb8bc7fedb1bd383e7d4de1`;
- `artifacts/fullstack/2026-08-22T01-59-11.028Z-b3e12df3f7c7-6e6fe83f7dbf-run-2/evidence.json`
  — SHA-256 `a6f0f67894939e9bdae87440499c3b52e57c4bf4572ac259683e1771ad6397d7`.

Guard-removal hiện là WIP riêng: chỉ bỏ production rejection, không đổi bất kỳ default nào sang
`true`. Independent review của diff này và hai run fresh-volume production-mode vẫn pending;
VS-035B/backend #30 tiếp tục Open và chưa có production-ready claim.

Sau commit guard-removal, lần chạy production-mode cuối và CI phải đặt đồng thời:

```text
DANANGMAP_ASYNC_API_NODE_ENV=production
DANANGMAP_CANONICAL_WORKER_NODE_ENV=production
```

Không đặt một phía production và phía còn lại development/test. Pretrial đã chấp nhận ở trên giữ cả
hai mặc định `development` khi production guard còn hiệu lực; nó không thay thế hai run
production-mode sau guard-removal.
