# Durable publication activation runbook

## Trạng thái an toàn hiện tại

- `ASYNC_PUBLICATION_ENABLED=false` ở schema, `.env.example` và Compose mặc định.
- `NODE_ENV=production` vẫn từ chối `ASYNC_PUBLICATION_ENABLED=true` ở checkpoint này.
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

Không gỡ production guard trong cùng commit chuẩn bị harness. Sau khi frontend activation SHA được
pin, independent review GO và hai run pass, guard removal là commit riêng: chỉ bỏ production rejection,
không đổi bất kỳ default nào sang `true`.

Sau commit guard-removal, lần chạy production-mode cuối và CI phải đặt đồng thời:

```text
DANANGMAP_ASYNC_API_NODE_ENV=production
DANANGMAP_CANONICAL_WORKER_NODE_ENV=production
```

Không đặt một phía production và phía còn lại development/test. Pretrial của commit harness hiện tại
giữ cả hai mặc định `development` vì production guard vẫn còn hiệu lực.
