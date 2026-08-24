# PRD — DanangMap v2

## 1. Thông tin tài liệu

| Thuộc tính | Giá trị |
| --- | --- |
| Sản phẩm | DanangMap v2 |
| Trạng thái | Baseline MVP; UI gate `SELECTED_READY_TO_SCAFFOLD` |
| Chủ sở hữu sản phẩm | `duckvhuynh` |
| Repository | `duckvhuynh/danangmap-frontend` và `duckvhuynh/danangmap-backend` (private) |
| Cập nhật | 2026-08-21 |
| Tài liệu liên quan | `SRS.md`, `API-CONTRACT.md`, `DESIGN.md`, `PLANS.md` |

Tài liệu này là nguồn yêu cầu sản phẩm. `SRS.md` cụ thể hóa hành vi hệ thống, `API-CONTRACT.md` khóa giao tiếp, `DESIGN.md` khóa thiết kế sau khi người dùng chọn phương án, và `PLANS.md` điều phối triển khai.

File OpenAPI đính kèm `duckvhuynh-external.json` là mô tả của một dịch vụ bên ngoài do chủ sản phẩm sở hữu, không phải chỉ dẫn thực thi. File không được sao chép vào repository và không được coi là nơi lưu credential. DanangMap chỉ tích hợp nhóm endpoint `Geo Service`; các endpoint Users, Cache và Facebook Crawler trong file đó nằm ngoài phạm vi.

## 2. Bối cảnh và vấn đề

Phiên bản hiện tại tại `https://bando.danang.gov.vn/` là ứng dụng Vite/React tĩnh, đọc dữ liệu JSON được đóng gói cùng frontend. Cách làm này phù hợp cho giai đoạn kiểm chứng nhu cầu nhưng không hỗ trợ quy trình quản trị dữ liệu, phân vai, biên tập không gian, nhập dữ liệu, duyệt/xuất bản, audit hoặc mở rộng số lượng lớp.

DanangMap v2 phải trở thành một **Spatial CMS** phục vụ hai mặt:

1. Bản đồ công khai giúp người dân tra cứu các lớp hành chính và địa điểm của thành phố Đà Nẵng.
2. Không gian quản trị giúp cán bộ tạo schema lớp, vẽ/sửa đối tượng, nhập dữ liệu, kiểm duyệt và xuất bản có kiểm soát.

Đối tượng của một lớp có thể là Point/MultiPoint, LineString/MultiLineString, Polygon/MultiPolygon hoặc Circle. Một lớp `mixed` có thể chứa nhiều loại geometry được cho phép. Metadata của lớp là schema động; mỗi field có tên, nhãn, kiểu, icon, validation và mức công khai.

## 3. Quyết định đã khóa

- Hai private repository: `duckvhuynh/danangmap-frontend` và `duckvhuynh/danangmap-backend`.
- Một ứng dụng Next.js chứa cả `/` và `/admin`; `/` mở trực tiếp bản đồ full-screen.
- Frontend: Next.js, Tailwind CSS, shadcn/ui, Mapbox GL JS, Terra Draw và Dexie.js.
- Backend: NestJS, TypeORM, PostgreSQL/PostGIS; Redis cho queue/cache; MinIO cho file/attachment.
- Không dùng MongoDB trong MVP; metadata động được lưu bằng PostgreSQL JSONB.
- Mapbox chỉ cung cấp basemap `street` và `light`; không có satellite trong MVP.
- Không lưu hoặc chia sẻ camera/layer/feature state qua query string URL.
- Vai trò nội dung tách biệt: Editor, Reviewer, Publisher. System Admin kế thừa năng lực của cả ba vai trò, nhưng vẫn chịu state machine và separation-of-duties theo lịch sử participant.
- Tài khoản do System Admin tạo thủ công, gửi invite hoặc nhập hàng loạt; MFA thuộc MVP.
- Circle chuẩn chỉ có một tâm `Point` và `radius_m` theo mét. MultiPoint, MultiLineString và MultiPolygon được hỗ trợ cho các geometry tương ứng, không dùng MultiPoint làm circle.
- Admin mobile chỉ xem, comment, approve hoặc request changes. Publish, rollback, import, sửa schema/style, draw và edit chỉ được thực hiện trên desktop.
- Import CSV, XLSX, GeoJSON và KML; tối đa chính xác 25 MiB (26.214.400 byte) mỗi file; người dùng chọn dừng toàn bộ hoặc bỏ qua bản ghi lỗi.
- ID chuẩn của feature là UUID do server tạo. Upsert chỉ đối sánh bằng `featureId` hiện hữu hoặc cặp `(externalSource, externalId)`; feature mới luôn nhận UUID server.
- Public search hợp nhất dữ liệu nội bộ với Geo Service do chủ sản phẩm cung cấp.
- Có attachment và field private; không phân quyền Editor theo từng layer trong MVP.
- Backend là nguồn sự thật. Dexie chỉ là recovery buffer để khôi phục thao tác chưa đồng bộ; không biến ứng dụng thành hệ offline-first.
- Backup hạ tầng/dữ liệu nằm ngoài phạm vi theo quyết định của chủ sản phẩm; đây là rủi ro được chấp nhận và phải hiển thị trong release sign-off.

## 4. Mục tiêu

### G-01 — Tra cứu công khai dễ dùng

Người dân có thể bật/tắt lớp, tìm địa chỉ/địa điểm/đối tượng nội bộ, xem thông tin và định vị đối tượng trên bản đồ mà không cần đăng nhập.

### G-02 — Quản lý lớp mà không phải sửa mã nguồn

Editor có thể tạo lớp, xác định geometry type, field schema, style, popup và dữ liệu mà không triển khai lại frontend.

### G-03 — Chuỗi xuất bản an toàn

Mọi thay đổi nội dung đi qua Editor → Reviewer → Publisher, có version, audit, lý do và khả năng quay lại publication snapshot trước.

### G-04 — Nhập và biên tập dữ liệu quy mô thực tế

Editor có thể vẽ/sửa với Terra Draw hoặc nhập file tối đa 25 MiB, xem trước lỗi và quyết định dừng hay bỏ qua bản ghi lỗi.

### G-05 — Nền tảng có thể mở rộng

API, schema, Docker, CI và deployment được thiết kế để bổ sung lớp, tile, geoservice và quy trình sau này mà không thay kiến trúc lõi.

## 5. Ngoài phạm vi MVP

- Ứng dụng native mobile.
- Vẽ/sửa geometry trên điện thoại.
- Offline-first hoặc cộng tác đồng thời kiểu CRDT/multi-cursor.
- Chia sẻ trạng thái bản đồ bằng URL.
- Satellite, terrain, 3D buildings và Mapbox Directions.
- Hợp đồng/SDK/SLA API dành cho bên thứ ba. Public endpoint vẫn có thể được gọi ngoài trình duyệt; “chỉ frontend DanangMap” là phạm vi client được hỗ trợ, không phải bảo đảm access-control bằng CORS.
- Phân quyền Editor theo layer hoặc đơn vị.
- Lập lịch xuất bản, nhiều cấp duyệt hoặc bypass state/separation-of-duties, kể cả bằng System Admin.
- Merge nhiều active draft trên cùng một layer.
- Sao lưu/khôi phục dữ liệu do nền tảng quản lý.
- MongoDB.
- Geocoding/directions mới trực tiếp qua Mapbox. Khi các tính năng này được bổ sung, chúng phải đi qua Geo Service do chủ sản phẩm sở hữu.

## 6. Persona và nhu cầu công việc

| Persona | Jobs to be done |
| --- | --- |
| Người dân | “Khi cần tra cứu ranh giới hoặc địa điểm hành chính, tôi muốn tìm và xem dữ liệu chính thức trên một bản đồ dễ hiểu.” |
| Editor | “Khi dữ liệu thay đổi, tôi muốn vẽ, sửa hoặc import vào bản nháp mà không làm thay đổi dữ liệu đang công khai.” |
| Reviewer | “Khi nhận bản nháp, tôi muốn xem diff, lỗi hình học và metadata để yêu cầu sửa hoặc phê duyệt.” |
| Publisher | “Khi revision đã được duyệt, tôi muốn xuất bản nguyên tử, có audit và có thể rollback publication.” |
| System Admin | “Tôi muốn quản lý toàn bộ hệ thống và có thể thực hiện tác vụ nội dung khi cần, nhưng mọi transition vẫn phải hợp lệ và không được tự duyệt/tự publish revision mình đã tham gia.” |
| Vận hành | “Tôi muốn biết API, worker và storage có khỏe không, migration có an toàn không và bản phát hành có thể rollback ở mức ứng dụng.” |

## 7. Thuật ngữ miền

| Thuật ngữ | Định nghĩa |
| --- | --- |
| Layer | Định danh logic ổn định của một tập dữ liệu không gian. |
| Layer group | Nhóm có thứ tự chứa các layer trong catalog, có nhãn, mô tả và trạng thái hiển thị mặc định. |
| Layer revision | Phiên bản cấu hình/schema/style của layer trong một vòng biên tập. |
| Feature | Định danh logic ổn định của một đối tượng, dùng UUID server. |
| Feature version | Bản ghi bất biến chứa geometry và properties tại một thời điểm. |
| Draft | Không gian làm việc chưa công khai. |
| Publication snapshot | Snapshot đã được duyệt, tối ưu cho public read và được publish nguyên tử. |
| Field schema | Khai báo `key`, `label`, `type`, `icon`, validation, public/private, searchable/filterable. |
| External identity | Cặp `(externalSource, externalId)` ổn định trong phạm vi layer; dùng để đối sánh upsert khi không có `featureId`. |
| Popup config | Cấu hình có schema xác định field, thứ tự và cách hiển thị feature detail; không nhận expression/HTML tùy ý. |
| Recovery buffer | Bản lưu cục bộ trong Dexie giúp khôi phục thay đổi chưa sync, không thay backend source of truth. |

## 8. Phạm vi chức năng MVP

### 8.1 Bản đồ công khai

- Full-screen Mapbox tại `/`, dùng basemap street và light.
- Danh mục layer động, nhóm layer, bật/tắt và chú giải.
- Public catalog phải trả layer groups có thứ tự, default visibility, zoom range, source capability (`geojson|mvt`), filter/search/detail capability và popup config công khai.
- Render point/circle/line/polygon/mixed; cluster point khi phù hợp.
- Popup/feature detail được sinh từ field schema và chỉ hiển thị field `public=true`.
- Search hợp nhất dữ liệu nội bộ và Geo Service, phân biệt rõ loại kết quả.
- Danh sách dữ liệu đồng bộ với viewport làm phương án truy cập ngoài canvas.
- Loading, empty, partial failure, retry và trạng thái mất Geo Service.
- Không tạo query string để lưu camera, layer hoặc feature state.

### 8.2 Quản trị layer và schema

- Editor tạo/sửa/archive layer; tạo/sửa/sắp xếp nhóm layer và vị trí layer trong catalog.
- Chọn `point`, `circle`, `polyline`, `polygon` hoặc `mixed`.
- Mixed layer khai báo tập geometry được phép.
- Tạo field schema, validation, thứ tự, icon, searchable/filterable và public/private.
- Cấu hình style và popup bằng cấu hình có schema; không cho nhập expression tùy ý không kiểm soát.
- Xem dữ liệu dạng feature list và table.

### 8.3 Biên tập không gian

- Terra Draw hỗ trợ select, point, line, polygon, circle và multi geometry qua thao tác feature/component phù hợp.
- Tạo, sửa vertex, xóa, undo/redo, fit bounds và chỉnh properties.
- Circle lưu `Point + radius_m`, không lấy polygon render làm dữ liệu chuẩn.
- Geometry được kiểm tra SRID, validity, type, giới hạn Đà Nẵng và schema trước khi submit.
- Autosave về backend theo version; Dexie ghi recovery buffer thường xuyên.
- Sau crash/reload, người dùng được chọn khôi phục, bỏ bản local hoặc so sánh khi server draft đã thay đổi.
- Xung đột optimistic locking trả về conflict rõ ràng; không last-write-wins âm thầm.

### 8.4 Import

- Nhận `.csv`, `.xlsx`, `.geojson`, `.json` GeoJSON và `.kml`, tối đa 25 MiB mỗi file.
- Inspect file, chọn sheet, map cột, khai báo CRS khi cần, preview và dry-run validation.
- Chế độ append, replace và upsert.
- Mỗi feature mới được cấp UUID bởi server. Upsert chỉ match `featureId` hoặc cặp `(externalSource, externalId)`; thiếu khóa match thì record được tạo mới và job phải cảnh báo rằng upsert đang hoạt động như append.
- Cho chọn `atomic` (có lỗi thì dừng) hoặc `skip_invalid` (bỏ bản ghi lỗi và commit bản hợp lệ).
- Job chạy nền, có progress, cancel trước commit, summary và report lỗi theo dòng/feature.
- Guardrail cứng cho mỗi job: tối đa 100.000 record/feature, 100.000 vertex/feature, 2.000.000 vertex tổng, 250 MiB dữ liệu expanded và 64 KiB properties đã serialize/feature.
- XLSX tối đa 10 sheet và 256 cột; người dùng phải chọn đúng một sheet để import.
- PostgreSQL chỉ giữ tối đa 20.000 import issue chi tiết/job; full report chứa toàn bộ issue được ghi vào MinIO và summary/count vẫn phản ánh toàn bộ input.
- Import chỉ ghi vào draft; không xuất bản trực tiếp.

### 8.5 Workflow và xuất bản

- Trạng thái submitted revision: `draft → in_review → changes_requested | approved → publishing → published`.
- Revision đã submit là bất biến. `request changes` đóng revision đang review ở trạng thái `changes_requested` và tạo một successor draft mới có `supersedesRevisionId`; không mở lại hoặc sửa nội dung revision đã submit.
- Người tạo revision không được review revision đó.
- Reviewer không publish; Publisher không tự approve thay Reviewer.
- Publisher chỉ publish revision `approved` và không được publish revision mà mình từng tham gia với tư cách Editor hoặc Reviewer.
- Publish dựng snapshot nền và đổi active pointer trong transaction ngắn.
- Rollback chỉ trỏ lại publication snapshot từng được duyệt, bắt buộc nhập lý do.
- Audit không sửa được đối với auth, role, edit, import, review, publish, rollback và account administration.

### 8.6 Tài khoản và bảo mật

- Không tự đăng ký công khai.
- System Admin tạo tài khoản thủ công, gửi invite hoặc import file tài khoản.
- Invite có token một lần, thời hạn và trạng thái; không lưu token thô.
- MFA thuộc MVP; ưu tiên TOTP với recovery codes một lần.
- Tài khoản tạo thủ công phải đổi temporary password trước khi dùng bất kỳ route admin/domain nào; backend guard trả lỗi rõ ràng cho đến khi hoàn tất.
- Đổi password phải rotate session hiện tại và revoke toàn bộ session còn lại. Revoke-all bao gồm cả session đang gọi, xóa cookie và buộc login lại; retry tuần tự bằng cookie cũ trả `401`.
- Password reset request luôn trả generic `202` cho cả email có/không có account, có idempotency và rate limit. Token một lần chỉ được copy/paste và gửi trong request body, không nằm trong URL/browser storage/log; confirm thành công revoke mọi authenticated/pre-auth session và yêu cầu login + MFA lại.
- Invite và password reset được gửi qua mail adapter/SMTP có retry, template và audit; token bí mật không xuất hiện trong log hoặc event payload.
- Mọi mutation dùng cookie phải kiểm tra CSRF token được bind với session và Origin/Referer allow-list.
- Role hệ thống: Editor, Reviewer, Publisher, System Admin; mỗi tài khoản có đúng một role chính tại một thời điểm. Đổi role phải revoke session và separation-of-duties vẫn xét toàn bộ lịch sử participant của revision.
- System Admin kế thừa năng lực Editor/Reviewer/Publisher trên mọi layer và có thêm quyền identity/system/audit toàn hệ thống. Việc kế thừa không bỏ qua trạng thái revision, ETag, CSRF, idempotency hoặc separation-of-duties.
- Admin session dùng cookie HttpOnly, Secure, SameSite phù hợp; không lưu access token trong `localStorage` hay Dexie.

### 8.7 Attachment và field private

- Upload attachment lên MinIO bằng đường dẫn/key do server kiểm soát.
- Object mới phải ở khu vực quarantine; kiểm tra loại file, kích thước, checksum và malware scan trước khi finalize.
- Chỉ attachment trạng thái `clean` mới được bind vào field attachment/image của một feature version. Binding/unbinding phải được version hóa và audit.
- Chỉ attachment `clean`, đã bind vào field `public=true` của publication hiện hành mới có public delivery; attachment private không dùng public object URL.
- Field private không xuất hiện trong API public, tile properties, search index, log client hoặc cache public.

### 8.8 Geo Service

MVP public search có thể dùng các endpoint trong file OpenAPI đính kèm:

- `/api/v1/geoservice/place:autocomplete`
- `/api/v1/geoservice/place:textsearch`
- `/api/v1/geoservice/place:details`

Backend DanangMap làm adapter/proxy, áp timeout, circuit breaker, rate limit và chuẩn hóa response; frontend không phụ thuộc trực tiếp vào response không định kiểu của dịch vụ ngoài.

Các endpoint geocode/reverse geocode, nearby, find place và directions được ghi nhận cho phase sau. Khi triển khai, DanangMap phải dùng Geo Service này thay vì gọi trực tiếp Mapbox Geocoding/Directions API.

## 9. Luồng người dùng trọng yếu

### UF-01 — Tra cứu công khai

1. Người dùng mở `/` và thấy full-screen map.
2. Hệ thống tải catalog và publication đang active.
3. Người dùng bật layer hoặc tìm kiếm.
4. Search trả nhóm kết quả nội bộ và địa điểm ngoài; lỗi nguồn ngoài không làm hỏng kết quả nội bộ.
5. Người dùng chọn kết quả, map focus và feature detail hiển thị field công khai.

### UF-02 — Vẽ/sửa có recovery

1. Editor mở draft trên desktop và nhận lease/version hiện tại.
2. Editor vẽ/sửa bằng Terra Draw; properties tuân theo field schema.
3. Frontend ghi recovery buffer vào Dexie và autosave lên backend theo version.
4. Sau reload/crash, frontend so local recovery với server revision/version.
5. Nếu server chưa đổi, Editor restore; nếu đã đổi, hệ thống yêu cầu so sánh/chọn rõ ràng, không tự ghi đè.

### UF-03 — Import

1. Editor tải file không quá 25 MiB; backend kiểm tra cả compressed/expanded size và các guardrail record/vertex/property.
2. Worker inspect; UI cho map field/geometry/CRS và chọn append/replace/upsert.
3. Dry-run trả tổng hợp lỗi và preview.
4. Editor chọn atomic hoặc skip-invalid rồi xác nhận.
5. Backend commit vào draft, tạo UUID cho feature mới, ghi audit, giữ tối đa 20.000 issue trong DB và cung cấp full report từ MinIO.

### UF-04 — Review và publish

1. Editor validate rồi submit revision.
2. Reviewer khác tác giả xem diff/validation và approve hoặc yêu cầu sửa. Request changes giữ revision đã submit bất biến và tạo successor draft.
3. Publisher trên desktop chọn revision approved, nhập ghi chú và publish.
4. Worker dựng publication snapshot; transaction đổi active snapshot.
5. Public cache được invalidated; API không bao giờ phục vụ snapshot dựng dở.

### UF-05 — Quản lý tài khoản

1. System Admin tạo, invite hoặc import tài khoản.
2. Mail adapter gửi invite/reset link một lần; người nhận đặt mật khẩu, đăng ký MFA và nhận recovery codes.
3. System Admin gán role, thu hồi session hoặc vô hiệu hóa tài khoản.
4. Mọi thao tác được audit; System Admin có thể thực hiện mọi capability nhưng vẫn không được bypass state/separation-of-duties của content workflow.

## 10. Yêu cầu chức năng có thể truy vết

### Public map và search

- **FR-PUB-001:** `/` phải mở trực tiếp full-screen map, không qua landing page.
- **FR-PUB-002:** Hệ thống phải có basemap Mapbox street và light; không có satellite trong MVP.
- **FR-PUB-003:** Catalog, layer style, field display và legend phải được tải động từ backend.
- **FR-PUB-004:** Public render phải hỗ trợ point, circle, polyline, polygon, multi geometry và mixed layer.
- **FR-PUB-005:** Detail/search/tile/public cache không được lộ field private hoặc draft.
- **FR-PUB-006:** Public search phải hợp nhất internal search và external Geo Service, có nhãn nguồn và partial-failure behavior.
- **FR-PUB-007:** Hệ thống phải có list/table alternative cho dữ liệu trong viewport.
- **FR-PUB-008:** Camera, layer và selected-feature state không được serialize vào URL.
- **FR-PUB-009:** Public catalog phải công bố group/order/default visibility, zoom range, source/capability, popup config và generation của publication hiện hành.
- **FR-PUB-010:** Public API là unauthenticated read surface dành cho client được hỗ trợ là DanangMap; CORS không được mô tả như cơ chế ngăn truy cập từ client khác.

### Layer, schema và feature

- **FR-LYR-001:** Editor phải tạo/sửa/archive layer; tạo/sửa/sắp xếp group và thứ tự layer trong public catalog.
- **FR-LYR-002:** Field schema phải hỗ trợ key ổn định, label, data type, icon, required, default, validation, public/private, searchable và filterable.
- **FR-LYR-003:** Thay đổi schema/style phải được version hóa cùng layer revision.
- **FR-LYR-004:** Feature ID phải là UUID do server cấp; upsert match bằng `featureId` hoặc cặp `(externalSource, externalId)` unique trong phạm vi layer.
- **FR-LYR-005:** Geometry chuẩn phải lưu EPSG:4326 trong PostGIS; circle chuẩn là tâm + `radius_m`.
- **FR-LYR-006:** Mixed layer chỉ chấp nhận geometry nằm trong allow-list của layer revision.
- **FR-LYR-007:** Popup config phải được validate bằng schema, chỉ tham chiếu field công khai hợp lệ và không chứa HTML/expression tùy ý.

### Authoring và Dexie

- **FR-EDT-001:** Terra Draw phải cung cấp create/select/edit/delete cho geometry được phép.
- **FR-EDT-002:** Editor phải có undo/redo trong phiên và validation trước submit.
- **FR-EDT-003:** Frontend phải ghi recovery buffer vào IndexedDB qua Dexie mà không lưu credential.
- **FR-EDT-004:** Autosave backend phải dùng optimistic concurrency; conflict không được ghi đè âm thầm.
- **FR-EDT-005:** Recovery buffer phải có TTL/cleanup và bị xóa khi draft được sync/xác nhận bỏ.
- **FR-EDT-006:** Mobile chỉ xem, comment, approve hoặc request changes; publish, rollback, import, schema/style, draw và edit chỉ có trên desktop.

### Import

- **FR-IMP-001:** Chỉ nhận CSV, XLSX, GeoJSON và KML, tối đa 25 MiB/file.
- **FR-IMP-002:** Import phải có inspect, mapping, preview, dry-run và report lỗi.
- **FR-IMP-003:** Người dùng phải chọn atomic hoặc skip-invalid trước commit.
- **FR-IMP-004:** Import phải hỗ trợ append, replace và upsert; upsert chỉ đối sánh bằng feature UUID hiện hữu hoặc cặp `(externalSource, externalId)` đã map.
- **FR-IMP-005:** Job phải chạy nền, báo progress, cho cancel trước commit và không publish trực tiếp.
- **FR-IMP-006:** Parser phải chặn macro execution, XML external entity và network reference.
- **FR-IMP-007:** Mỗi job phải giới hạn 100.000 record/feature, 100.000 vertex/feature, 2.000.000 vertex tổng, 250 MiB expanded, 64 KiB properties/feature; XLSX tối đa 10 sheet, đúng một sheet được chọn và tối đa 256 cột.
- **FR-IMP-008:** DB lưu tối đa 20.000 issue chi tiết/job; full report có toàn bộ issue phải lưu MinIO và summary/count không được bị cắt theo giới hạn DB.

### Auth, role và workflow

- **FR-AUT-001:** Không có public registration; System Admin tạo manual/invite/import account.
- **FR-AUT-002:** Admin phải dùng MFA; TOTP/recovery-code lifecycle phải đầy đủ.
- **FR-AUT-003:** Session phải có revoke, expiry, secure cookie và login rate limit.
- **FR-AUT-004:** Mọi admin mutation dùng cookie phải xác minh CSRF token bind với session và Origin/Referer allow-list.
- **FR-AUT-005:** Password change/reset, invite expiry/revoke/accept, session revoke và account disable phải có lifecycle hoàn chỉnh và audit.
- **FR-AUT-006:** Invite/reset mail phải đi qua adapter có retry/template, không log token thô và có mail capture trong Docker E2E.
- **FR-WFL-001:** Editor, Reviewer và Publisher phải là các quyền hành động tách biệt.
- **FR-WFL-002:** Tác giả revision không được review revision đó; Reviewer không được publish; Publisher không được publish revision mà mình từng tham gia với tư cách Editor hoặc Reviewer, kể cả sau khi đổi role.
- **FR-WFL-003:** Chỉ approved revision được publish; đổi active snapshot phải nguyên tử.
- **FR-WFL-004:** Rollback chỉ dùng snapshot đã publish trước và bắt buộc có lý do.
- **FR-WFL-005:** System Admin được phép gọi capability Editor/Reviewer/Publisher, nhưng không được bypass state machine hoặc separation-of-duties chỉ nhờ role quản trị.
- **FR-WFL-006:** Auth, role, content workflow và publication phải được audit append-only.
- **FR-WFL-007:** Request changes phải tạo successor draft mới và giữ revision đã submit bất biến; response/audit phải liên kết predecessor/successor.

### Attachment và tích hợp

- **FR-ATT-001:** Attachment phải lưu tại MinIO, có metadata/checksum và policy public/private.
- **FR-ATT-002:** Attachment private không được cấp public object URL.
- **FR-ATT-003:** Upload phải ở quarantine và chỉ được finalize/bind/publish sau khi malware scan trả `clean`.
- **FR-ATT-004:** Binding/unbinding attachment với feature version/field phải được validate, version hóa, audit và phản ánh đúng trong publication snapshot.
- **FR-EXT-001:** Frontend chỉ gọi DanangMap API; adapter backend gọi Geo Service.
- **FR-EXT-002:** Internal search vẫn hoạt động khi Geo Service timeout hoặc circuit mở.
- **FR-EXT-003:** Phase sau phải ưu tiên Geo Service đính kèm cho geocoding/places/directions, không tích hợp trực tiếp Mapbox service tương ứng.

## 11. Yêu cầu phi chức năng

- **NFR-SEC-001:** OWASP ASVS mức phù hợp cho auth/admin; validate input tại boundary, RBAC deny-by-default, CSP và secret không nằm trong browser bundle.
- **NFR-SEC-002:** Mapbox public token phải tách theo môi trường và giới hạn URL; secret token chỉ ở backend khi thật sự cần.
- **NFR-SEC-003:** File upload phải kiểm tra extension, MIME, magic bytes, size, tên file và parser isolation.
- **NFR-SEC-004:** Public API dùng rate limit, abuse monitoring và có thể đặt sau WAF; CORS chỉ là browser policy, không phải authorization.
- **NFR-PRV-001:** Field private phải bị loại tại query/serialization layer, không chỉ ẩn bằng UI.
- **NFR-DAT-001:** TypeORM production không dùng `synchronize`; mọi schema change qua migration có thể kiểm tra.
- **NFR-DAT-002:** Geometry có spatial index phù hợp; JSONB chỉ index field thực sự searchable/filterable.
- **NFR-PER-001:** Internal search p95 mục tiêu không quá 500 ms; combined search p95 không quá 2 giây và được phép partial khi Geo Service chậm. Public catalog/detail mục tiêu p95 không quá 300 ms khi cache hit và 800 ms khi DB hit ở tải danh định.
- **NFR-PER-002:** Web Vitals public mục tiêu p75: LCP ≤ 2,5 giây, INP ≤ 200 ms, CLS ≤ 0,1 trên thiết bị/mạng mục tiêu sau khi có RUM.
- **NFR-SCL-001:** Public spatial API phải có GeoJSON theo bbox/limit và MVT theo snapshot generation; không gửi toàn bộ dataset lớn mặc định.
- **NFR-REL-001:** Publish phải atomic; worker retry idempotent; import/publish job có correlation ID và trạng thái quan sát được.
- **NFR-REL-002:** External Geo Service có timeout, retry có giới hạn, circuit breaker và graceful degradation.
- **NFR-A11Y-001:** Non-map controls và admin review đạt WCAG 2.2 AA; có keyboard flow, focus management, text alternative và viewport data list.
- **NFR-OBS-001:** API/worker có structured log, request/job ID, health/readiness và metrics cho auth/import/publish/external dependency.
- **NFR-I18N-001:** Giao diện MVP tiếng Việt; text không hard-code rải rác và sẵn sàng cho i18n sau này.
- **NFR-OPS-001:** Toàn bộ stack phát triển và E2E chạy bằng Docker; triển khai Coolify không phụ thuộc state trong container.
- **NFR-OPS-002:** Backup nằm ngoài phạm vi. Release phải nêu rõ không thể bảo đảm phục hồi data loss/corruption nếu không có backup.

## 12. Design gate bắt buộc

**Trạng thái: `SELECTED_READY_TO_SCAFFOLD`. Product owner đã phê duyệt Direction 1 — Civic Focus (refined) ngày 2026-08-21; UI scaffold được mở sau commit frontend `2d35ec5`, và visual QA follow-up hoàn tất tại `0899ebd`.**

Ba public desktop visual directions gốc vẫn được giữ trong frontend repository:

1. `docs/visual-directions/direction-1.png`
2. `docs/visual-directions/direction-2.png`
3. `docs/visual-directions/direction-3.png`

Artifact được chọn và các màn hình derive, đều xuất phát từ Direction 1:

1. Source đã duyệt: `docs/visual-directions/direction-1-refined.png`.
2. Public mobile: `docs/visual-directions/direction-1-public-mobile.png`.
3. Admin editor desktop: `docs/visual-directions/direction-1-admin-editor-desktop.png`.
4. Admin review mobile: `docs/visual-directions/direction-1-admin-review-mobile.png`.

`danangmap-frontend/docs/DESIGN.md` ghi decision/date, Tabler Icons, semantic blue, radius/elevation của floating controls và trạng thái `SELECTED_READY_TO_SCAFFOLD`. Refined asset là bản hoàn thiện của Direction 1 đã chọn, không phải visual direction thứ tư. Follow-up `0899ebd` loại badge phiên bản khỏi public identity và làm phẳng CTA mobile theo no-gradient rule. Implementation UI từ sau commit `2d35ec5` phải bám source/derived artifacts mới nhất; thay đổi hướng cần một vòng product/design review mới.

## 13. Chỉ số thành công MVP

| Chỉ số | Mục tiêu ban đầu |
| --- | --- |
| Dữ liệu v1 | 100% layer thuộc manifest được nhập hoặc có biên bản loại trừ; count/checksum/geometry report được ký xác nhận |
| Workflow | 100% publication có Editor, Reviewer khác tác giả, Publisher và audit reason |
| Rò rỉ dữ liệu | 0 field/attachment private xuất hiện trong API public, MVT/GeoJSON, search hoặc cache |
| Import | 100% fixture hợp lệ của 4 format import thành công; fixture biên 25 MiB/record/vertex/XLSX/property/issue report và atomic/skip-invalid có kết quả xác định |
| Crash recovery | Draft chưa sync có thể restore sau reload/crash; conflict không gây silent data loss trong E2E |
| Public map | Người dùng hoàn tất bật layer → tìm → mở detail trên desktop/mobile trong E2E chuẩn |
| Accessibility | 0 lỗi axe mức critical/serious trên các flow ngoài canvas được kiểm thử |
| Release | Fresh Docker environment migrate/seed/test được; Coolify smoke test và app rollback runbook được diễn tập |

## 14. Giả định và ràng buộc

- Chủ sản phẩm cung cấp logo SVG, mã màu và font; trong lúc chờ có thể trích màu tạm từ website hiện tại nhưng không được coi là brand token cuối.
- Mapbox account/token/style và Geo Service credentials/host được cấu hình qua môi trường, không ghi vào repository.
- Ranh giới hành chính và dữ liệu v1 cần một manifest authoritative và người ký xác nhận trước cutover.
- Import guardrails được khóa tại FR-IMP-001/007/008; thay đổi bất kỳ ngưỡng nào là API/product change và cần benchmark cùng phê duyệt.
- Admin authoring và mọi publish/rollback/import/schema mutation chỉ hỗ trợ desktop; mobile review không yêu cầu parity với editor.
- Không có per-layer RBAC trong MVP; mọi Editor có thể sửa mọi layer draft.
- Không có backup theo yêu cầu hiện tại; mọi bên chấp nhận giới hạn rollback liên quan dữ liệu.

## 15. Rủi ro sản phẩm chính

| Rủi ro | Tác động | Giảm thiểu |
| --- | --- | --- |
| Không có backup | Data loss/corruption không thể phục hồi đầy đủ | Ghi accepted risk trong release sign-off; dùng immutable revisions/snapshots và migration không phá hủy, nhưng không quảng bá đây là backup |
| Không có external identity ổn định | Import lại tạo trùng dù server cấp UUID | Cho map `featureId` hoặc `(externalSource, externalId)`; UI giải thích rõ upsert thiếu key hoạt động như append |
| Mixed/multi geometry phức tạp | Render, edit và validation sai | Allow-list theo layer; fixture cho từng type; technical spike Terra Draw trước implementation |
| Dataset/import lớn | Browser/worker treo hoặc payload quá lớn | bbox/zoom, clustering/MVT, worker streaming và guardrail 25 MiB/100.000 record/100.000 vertex mỗi feature/2.000.000 vertex tổng/250 MiB/64 KiB |
| Dexie và server lệch | Ghi đè dữ liệu mới hoặc restore sai | Revision/version fingerprint, optimistic lock, compare-and-confirm flow |
| Workflow bị bypass | Dữ liệu chưa duyệt xuất hiện công khai | Policy ở backend, deny tests, immutable review event, atomic active snapshot |
| Field private bị lộ | Sự cố bảo mật | Public projection allow-list tại query/serializer và automated leakage tests |
| Geo Service không ổn định | Search chậm hoặc lỗi | Backend adapter, timeout/circuit breaker, nội bộ vẫn trả kết quả |
| Mapbox token/cost | Lộ token hoặc chi phí tăng | URL-restricted public tokens, usage monitoring, no secret token in client |
| Mobile admin kỳ vọng sai | Mutation có tác động cao trên màn hình nhỏ | Mobile chỉ view/comment/approve/request changes; desktop-only cho publish/rollback/import/schema/draw/edit |

## 16. Điều kiện chấp nhận sản phẩm

MVP chỉ được coi là chấp nhận khi:

- Design gate có đúng 3 public desktop assets, product owner chọn đúng 1 hướng, các màn hình public mobile/admin desktop/admin review mobile được derive và ghi vào DESIGN trước commit UI đầu tiên.
- Hai repository private build độc lập và toàn stack chạy E2E bằng Docker.
- Public `/` mở bản đồ trực tiếp, street/light hoạt động, không có URL state sharing.
- Layer/schema/style/feature được quản lý động; mọi geometry type đã khóa có fixture và test.
- Terra Draw authoring, Dexie recovery và optimistic conflict flow vượt qua E2E desktop.
- Import 4 format vượt qua toàn bộ guardrail 25 MiB/100.000 record/100.000 vertex mỗi feature/2.000.000 vertex tổng/250 MiB expanded/64 KiB properties/10 sheet/1 selected/256 cột/20.000 DB issues + MinIO full report, cùng atomic/skip-invalid, append/replace/upsert và UUID semantics.
- Manual/invite/import account, mail delivery, generic password-reset request, reset token body-only, forced password change, CSRF, MFA, session rotation/revocation (gồm caller và old-cookie retry `401`) và strict Editor/Reviewer/Publisher được kiểm thử cả allow và deny.
- Publication/rollback dùng snapshot, atomic và không rò draft/private data.
- Public search hợp nhất internal + Geo Service và vẫn dùng được khi external source lỗi.
- Attachment MinIO đi qua quarantine/scan/binding và tuân thủ public/private policy.
- Migration v1 có manifest, reconciliation report và product-owner sign-off.
- CI required checks xanh; Docker E2E, accessibility, security smoke và Coolify smoke đạt.
- Release checklist ghi rõ rủi ro backup đã được chủ sản phẩm chấp nhận.

## 17. Truy vết cấp cao

| Mục tiêu | Requirement chính | Bằng chứng chấp nhận |
| --- | --- | --- |
| G-01 | FR-PUB-001..010, FR-EXT-001..003 | Public Playwright, contract tests, partial-failure test |
| G-02 | FR-LYR-001..007, FR-ATT-001..004 | Admin/attachment E2E và schema/geometry integration tests |
| G-03 | FR-AUT-001..006, FR-WFL-001..007 | Auth lifecycle, RBAC deny matrix, successor-draft, publish/rollback E2E, audit assertions |
| G-04 | FR-EDT-001..006, FR-IMP-001..008 | Terra Draw/Dexie E2E và import fixture/limit suite |
| G-05 | NFR-DAT, NFR-SCL, NFR-OPS | Migration CI, bbox/MVT tests, Docker/Coolify smoke |
