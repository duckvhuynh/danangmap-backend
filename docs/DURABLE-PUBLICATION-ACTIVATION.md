# Durable publication activation runbook

## Trạng thái an toàn hiện tại

- `ASYNC_PUBLICATION_ENABLED=false` ở schema, `.env.example` và Compose mặc định.
- Guard-removal đã review chỉ bỏ validation rejection khi production được đặt explicit
  `ASYNC_PUBLICATION_ENABLED=true`; không có cấu hình nào tự bật cờ này. Local production activation
  gate đã GO ở exact SHA ghi bên dưới, nhưng release tổng thể vẫn NO-GO theo các boundary còn mở.
- Harness dùng API/worker runtime thật, PostGIS, Redis/BullMQ, MinIO, Next.js và Playwright qua
  `https://gateway`; không có route mock, service mock, test HTTP endpoint hoặc Docker socket trong
  browser.
- Chỉ `crash-worker` chạy `NODE_ENV=test` để dùng advisory barrier. Harness bắt buộc khai báo
  activation mode cùng `NODE_ENV` đối xứng của API/canonical worker trước khi chạy Compose; Compose
  mặc định dùng `development` ngoài harness.

## Exact-SHA inputs

```powershell
$env:DANANGMAP_BACKEND_SHA = (git rev-parse HEAD)
$env:DANANGMAP_FRONTEND_CONTEXT = "D:/path/to/danangmap-frontend"
$env:DANANGMAP_FRONTEND_SHA = (git -C $env:DANANGMAP_FRONTEND_CONTEXT rev-parse HEAD)
$env:DANANGMAP_FULLSTACK_RUNS = "2"
$env:DANANGMAP_ACTIVATION_MODE = "pretrial"
$env:DANANGMAP_ASYNC_API_NODE_ENV = "development"
$env:DANANGMAP_CANONICAL_WORKER_NODE_ENV = "development"
npm run test:fullstack:harness
```

Hai worktree phải clean và SHA phải là full lowercase SHA. Frontend phải là descendant của
`cbb31e6b7901cd30f2fca8ba81ebe2f24e7e9d7f`; harness vẫn pin exact SHA được truyền, không chạy
floating branch/tag.

Harness không có fallback mode: `pretrial` chỉ chấp nhận cả API/worker là `development`, còn
`production` chỉ chấp nhận cả hai là `production`. Thiếu biến, giá trị sai hoặc cấu hình bất đối xứng
đều bị từ chối trước khi Compose khởi động. Manifest ghi `activationMode` và allowlist runtime thực tế
để một run development không thể được trình bày như production evidence.

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
job-level environment source dùng chung cho checkout và harness; job đặt activation mode và cả hai
API/worker `NODE_ENV` thành `production`.

Remote run `32547244858` có job `verify` pass nhưng cross-stack job fail đúng fail-closed guard vì
repository chưa cấp `CROSS_REPO_READ_TOKEN`; harness không chạy trên GitHub và không có remote
artifact để thay local exact-SHA evidence. Remote gate tiếp tục NO-GO cho tới khi secret được cấu hình
và job exact-SHA pass.

## Guard-intact pretrial đã chấp nhận

Independent audit đã chấp nhận pretrial dùng backend
`b3e12df3f7c728bf2499fc7fb90ff3a65762f3c8`, frontend
`6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8` và API/canonical worker mặc định
`development`. Hai fresh-volume run đều pass:

- `artifacts/fullstack/2026-08-22T01-54-15.498Z-b3e12df3f7c7-6e6fe83f7dbf-run-1/evidence.json`
  — SHA-256 `9f66aa554a08634657b15fc4e003befcc2dbf1b06fb8bc7fedb1bd383e7d4de1`;
- `artifacts/fullstack/2026-08-22T01-59-11.028Z-b3e12df3f7c7-6e6fe83f7dbf-run-2/evidence.json`
  — SHA-256 `a6f0f67894939e9bdae87440499c3b52e57c4bf4572ac259683e1771ad6397d7`.

Guard-removal đã được review và commit riêng: chỉ bỏ production rejection, không đổi bất kỳ default
nào sang `true`.

Mọi lần chạy production-mode và CI phải đặt đồng thời:

```text
DANANGMAP_ACTIVATION_MODE=production
DANANGMAP_ASYNC_API_NODE_ENV=production
DANANGMAP_CANONICAL_WORKER_NODE_ENV=production
```

Không đặt một phía production và phía còn lại development/test. Pretrial đã chấp nhận ở trên giữ cả
hai mặc định `development` khi production guard còn hiệu lực; harness hiện yêu cầu khai báo explicit
`pretrial` cùng hai giá trị `development`. Pretrial không được dùng thay production evidence ở phần
sau.

Full-stack Compose tạo certificate một lần trong fresh volume và bắt Mailpit dùng STARTTLS. Canonical
worker production mount certificate đó read-only qua `NODE_EXTRA_CA_CERTS`, giữ
`SMTP_REJECT_UNAUTHORIZED=true`; certificate local và private key không được đưa vào repository.

## Production activation evidence đã chấp nhận

Independent artifact review đã chấp nhận local production gate tại đúng backend
`2d4675ec2385abf55fa23ad26914e037456f14cd` + frontend
`6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8`:

- `artifacts/fullstack/2026-08-22T02-48-36.875Z-2d4675ec2385-6e6fe83f7dbf-run-1/evidence.json`
  — SHA-256 `6497db82ebfd8b92206cdfabd9ffa4456d650198e3501e33485a32d2d3e9516e`;
- `artifacts/fullstack/2026-08-22T02-53-38.466Z-2d4675ec2385-6e6fe83f7dbf-run-2/evidence.json`
  — SHA-256 `70a04b03205b6d58160bc22f50fd2abc10b00d4b6bec646f30d9d4dc1ca70c3a`.

Hai fresh-volume run có tổng cộng **18/18** Playwright invocation pass, `failed=0`, `skipped=0`,
`flaky=0`. API và canonical worker đều chạy `NODE_ENV=production`, async explicit true, không có test
control; canonical worker dùng trusted STARTTLS với `SMTP_REJECT_UNAUTHORIZED=true` và
`NODE_EXTRA_CA_CERTS`. Chỉ crash-worker chạy `NODE_ENV=test` với barrier dự kiến. Cả hai run chứng
minh attempt `0` khi queue, progress đúng `1/3`, SIGKILL non-OOM, terminal attempt `2`, recovered lease
`1`, generation `1→2`, đúng một snapshot/participant/workflow/audit mới và teardown residual
container/network/volume `0/0/0`.

VS-035B local activation gate là GO, nhưng đây không phải production release GO. Backend PR #38 vẫn
Draft, backend #30/frontend #19 vẫn Open; attachment binding/diff, explicit keyboard/screen-reader
regression, Mapbox visual QA với restricted token, Coolify deploy/cutover và accepted no-backup risk
vẫn là blocker. Mọi docs-only commit sau `2d4675ec...` chỉ ghi nhận evidence và **không** được mô tả là
SHA đã chạy harness.
