# API CONTRACT — DanangMap Backend

> Phiên bản nghiệp vụ: `/api/v1`; health không version hóa tại `/health/*`
> Trạng thái: baseline cho MVP; OpenAPI sinh từ code là artifact thực thi, tài liệu này là hợp đồng nghiệp vụ.
> Không có secret, token thật hoặc URL nội bộ trong ví dụ.

## 1. Quy ước chung

### 1.1 Giao thức

- HTTPS bắt buộc ngoài local development.
- JSON dùng camelCase, UTF-8; thời gian ISO 8601 UTC; ID là UUID.
- Geometry dùng GeoJSON RFC 7946, coordinate `[longitude, latitude]`, EPSG:4326.
- Bbox dùng `minLng,minLat,maxLng,maxLat`.
- Public response chỉ lấy active publication snapshot, trừ MVT URL generation-addressed trả đúng snapshot generation được yêu cầu.
- `Content-Type: application/problem+json` cho lỗi; MVT dùng `application/vnd.mapbox-vector-tile`.

### 1.2 Header

| Header            | Hướng                  | Quy định                                                                                                                                                                                                      |
| ----------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Request-Id`    | hai chiều              | Client có thể gửi UUID; server luôn trả request ID hợp lệ                                                                                                                                                     |
| `ETag`            | response               | Opaque entity/workspace/snapshot version                                                                                                                                                                      |
| `If-Match`        | request mutation       | Bắt buộc khi sửa resource versioned                                                                                                                                                                           |
| `If-None-Match`   | request GET            | Trả 304 khi không đổi                                                                                                                                                                                         |
| `Idempotency-Key` | request command        | UUID bắt buộc với command có thể retry                                                                                                                                                                        |
| `X-CSRF-Token`    | cookie-backed mutation | Bắt buộc cho login, mutation pre-auth (`mfa/verify`, `mfa/enroll`, `mfa/enroll/confirm`) và mọi mutation authenticated/admin; token lấy từ `/auth/csrf` và bind với trạng thái public/pre-auth/auth tương ứng |
| `Retry-After`     | 429/503                | Số giây client nên chờ                                                                                                                                                                                        |

Mọi response trả representation versioned của layer-group, layer, revision/workspace hoặc feature mutation phải gửi `ETag` ở runtime **và** khai báo header đó trong OpenAPI. ETag là opaque; client không tự dựng hoặc suy luận version. Preview config trả lại ETag hiện tại, mutation thành công trả ETag mới, và idempotent replay trả đúng body/ETag của lần đầu.

ETag collection được tính từ toàn bộ state ảnh hưởng representation. Với danh sách layer, state tối thiểu gồm layer identity/lock/archive và latest revision identity/lock/status, nên một revision config mutation cũng làm ETag danh sách thay đổi. Reorder phải dùng ETag vừa nhận từ đúng collection; thiếu `If-Match` trả `428 ETAG_REQUIRED`, stale token trả `412 ETAG_MISMATCH` kèm `currentEtag` khi an toàn.

### 1.3 Cookie admin

- `__Host-danangmap_session`: opaque random value, HttpOnly, Secure, SameSite=Lax, Path=/. Local HTTP development with `COOKIE_SECURE=false` uses the unprefixed `danangmap_session` / `danangmap_preauth` names because browsers reject `__Host-` cookies without `Secure`; production keeps the prefixed names.
- `danangmap_csrf`: token CSRF không HttpOnly để frontend đọc và echo qua `X-CSRF-Token`; không phải credential.
- Khi `MFA_ENABLED=true`, login trước MFA chỉ tạo pre-auth cookie hạn ngắn, không có quyền admin; khi `false` (mặc định), password hợp lệ tạo authenticated cookie trực tiếp.
- API không trả session/MFA secret trong JSON ngoài TOTP enrollment URI tại đúng bước enrollment; URI chỉ hiển thị một lần và không được log/lưu Dexie.
- `GET /auth/csrf` hoạt động ở cả ba trạng thái public, pre-auth và authenticated, luôn trả `Cache-Control: private, no-store`. Khi public cookie đã được thiết lập, endpoint reuse token có cú pháp hợp lệ; các request public cold đồng thời chưa có cookie có thể nhận token khác nhau và cookie response cuối cùng của browser thắng, nhưng chưa token nào bind với protected session. Pre-auth/authenticated chỉ trả lại token hiện tại khi cookie có cú pháp hợp lệ và hash khớp session active; endpoint không update `csrf_hash`, nên nhiều tab dùng chung session không vô hiệu hóa lẫn nhau. Thiếu/sai token ở session active trả `403 CSRF_INVALID` và không rebind hay mutation DB. Token chỉ rotate/bind tại trust/session boundary: public → pre-auth, pre-auth → authenticated, hoặc khi tạo/rotate session mới do password/session-security transition.
- Mọi POST dùng public/pre-auth/auth cookie phải gửi `Origin`/`Referer` thuộc allowlist và `X-CSRF-Token` khớp cookie. Thiếu/sai origin hoặc token trả `CSRF_INVALID`; cookie `SameSite` không thay thế kiểm tra này.

### 1.4 Success envelope

Single resource:

```json
{
  "data": {
    "id": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9"
  },
  "meta": {
    "requestId": "0192a6bd-1bde-7ae5-b003-0652104ddf56"
  }
}
```

Cursor collection:

```json
{
  "data": [],
  "meta": {
    "nextCursor": null,
    "hasMore": false,
    "limit": 50,
    "requestId": "0192a6bd-1bde-7ae5-b003-0652104ddf56"
  }
}
```

`cursor` là opaque base64url, không được client tạo/diễn giải. `limit` mặc định 50, tối đa 200 trừ khi endpoint ghi khác.

### 1.5 Error envelope

```json
{
  "type": "https://api.danangmap.local/problems/precondition-failed",
  "title": "Phiên bản dữ liệu đã thay đổi",
  "status": 412,
  "code": "ETAG_MISMATCH",
  "message": "Hãy tải thay đổi mới nhất trước khi lưu lại.",
  "details": {
    "currentEtag": "\"rev-42-v18\""
  },
  "requestId": "0192a6bd-1bde-7ae5-b003-0652104ddf56",
  "timestamp": "2026-08-20T18:30:00.000Z"
}
```

Validation error `details.violations`:

```json
{
  "code": "VALIDATION_FAILED",
  "message": "Dữ liệu gửi lên không hợp lệ.",
  "details": {
    "violations": [
      {
        "path": "properties.phone",
        "code": "INVALID_PHONE",
        "message": "Số điện thoại không đúng định dạng."
      }
    ]
  }
}
```

### 1.6 HTTP status

|  Status | Ý nghĩa                                                                            |
| ------: | ---------------------------------------------------------------------------------- |
| 200/201 | Thành công đồng bộ                                                                 |
|     202 | Command/job đã nhận                                                                |
|     204 | Thành công, không body                                                             |
|     304 | ETag chưa đổi                                                                      |
|     400 | Request sai cú pháp/quy tắc                                                        |
|     401 | Chưa xác thực/session hết hạn                                                      |
|     403 | Không đủ role hoặc vi phạm separation-of-duties                                    |
|     404 | Không tồn tại/không được nhìn thấy                                                 |
|     409 | Conflict nghiệp vụ/sync                                                            |
|     412 | `If-Match` không khớp                                                              |
|     413 | File/body quá 25 MiB hoặc limit endpoint                                           |
|     415 | MIME/format không hỗ trợ                                                           |
|     422 | Validation nội dung/geometry/schema thất bại                                       |
|     428 | Thiếu `If-Match` hoặc `Idempotency-Key` bắt buộc                                   |
|     429 | Rate limit                                                                         |
|     503 | Dependency bắt buộc chưa sẵn sàng; search external thường degraded 200 thay vì 503 |

Trong mọi bảng route bên dưới, `System Admin` thỏa mọi yêu cầu role nội dung `Editor`, `Reviewer` hoặc `Publisher`. Quyền kế thừa không bỏ qua ownership của resource, state machine, CSRF, ETag, idempotency hoặc separation-of-duties; System Admin từng `edit|review` revision vẫn không được publish/rollback revision đó.

### 1.7 Mã lỗi chuẩn

`AUTH_INVALID_CREDENTIALS`, `MFA_DISABLED`, `AUTH_MFA_REQUIRED`, `AUTH_MFA_INVALID`, `AUTH_MFA_ENROLLMENT_REQUIRED`, `AUTH_MFA_ENROLLMENT_ALREADY_STARTED`, `AUTH_MFA_ENROLLMENT_STALE`, `AUTH_MFA_ALREADY_ENROLLED`, `AUTH_MFA_RATE_LIMITED`, `AUTH_SESSION_EXPIRED`, `INVITE_INVALID_OR_EXPIRED`, `PASSWORD_CHANGE_REQUIRED`, `PASSWORD_RESET_INVALID_OR_EXPIRED`, `CSRF_INVALID`, `ROLE_FORBIDDEN`, `SEPARATION_OF_DUTIES`, `VALIDATION_FAILED`, `GEOMETRY_INVALID`, `GEOMETRY_TYPE_NOT_ALLOWED`, `RESOURCE_LIMIT_EXCEEDED`, `SCHEMA_VIOLATION`, `CONFIG_IMPACT_BLOCKED`, `ETAG_REQUIRED`, `ETAG_MISMATCH`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `DRAFT_ALREADY_EXISTS`, `REVISION_NOT_EDITABLE`, `WORKFLOW_TRANSITION_INVALID`, `PUBLICATION_BASE_STALE`, `SYNC_CONFLICT`, `SYNC_CURSOR_EXPIRED`, `IMPORT_TOO_LARGE`, `IMPORT_FORMAT_UNSUPPORTED`, `IMPORT_NOT_READY`, `IMPORT_HAS_ERRORS`, `ATTACHMENT_NAME_INVALID`, `ATTACHMENT_TYPE_UNSUPPORTED`, `ATTACHMENT_UPLOAD_INCOMPLETE`, `ATTACHMENT_UPLOAD_EXPIRED`, `ATTACHMENT_SIZE_MISMATCH`, `ATTACHMENT_MIME_MISMATCH`, `ATTACHMENT_CHECKSUM_MISMATCH`, `ATTACHMENT_NOT_READY`, `ATTACHMENT_ALREADY_BOUND`, `ATTACHMENT_OWNERSHIP_CONFLICT`, `ATTACHMENT_ORDER_INVALID`, `PUBLICATION_FAILED`, `FILTER_NOT_ALLOWED`, `QUERY_TOO_BROAD`, `GEO_SERVICE_INVALID_RESPONSE`, `RATE_LIMITED`.

## 2. DTO dùng chung

### 2.1 GeoJSON geometry

```ts
type Geometry =
  | { type: 'Point'; coordinates: [number, number] }
  | { type: 'MultiPoint'; coordinates: [number, number][] }
  | { type: 'LineString'; coordinates: [number, number][] }
  | { type: 'MultiLineString'; coordinates: [number, number][][] }
  | { type: 'Polygon'; coordinates: [number, number][][] }
  | { type: 'MultiPolygon'; coordinates: [number, number][][][] };
```

`GeometryCollection`, geometry null/rỗng và Z/M coordinate không hợp lệ trong MVP.

### 2.2 Feature DTO

```json
{
  "type": "Feature",
  "id": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
  "geometry": {
    "type": "Point",
    "coordinates": [108.2208, 16.0678]
  },
  "properties": {
    "name": "Trụ sở mẫu",
    "address": "Đà Nẵng"
  },
  "attachments": [],
  "meta": {
    "geometryKind": "point",
    "radiusM": null,
    "externalSource": "danang-legacy",
    "externalId": "office-001",
    "versionId": "0192a6c1-5bb4-7bc0-8376-c8d69bcd2f37",
    "updatedAt": "2026-08-20T18:30:00.000Z"
  }
}
```

Circle dùng `geometry.type=Point`, `meta.geometryKind=circle`, `meta.radiusM` là số mét dương.

### 2.3 Layer field

```json
{
  "id": "0192a6d0-cc89-77d0-8f82-adcc7f20bf33",
  "key": "phone",
  "label": "Số điện thoại",
  "description": null,
  "type": "phone",
  "icon": "phone",
  "required": false,
  "public": true,
  "searchable": true,
  "filterable": false,
  "sortable": false,
  "sensitive": false,
  "offlineCache": true,
  "defaultValue": null,
  "validation": {},
  "options": [],
  "displayOrder": 20
}
```

`type`: `text|long_text|number|integer|boolean|date|datetime|url|email|phone|enum|multi_enum|address|image|attachment`.

`sensitive=true` bắt buộc `offlineCache=false`. Backend reject schema vi phạm; frontend không được ghi value của field đó vào Dexie.

### 2.4 Layer style

Style là DTO DanangMap đã validate, không nhận Mapbox expression tùy ý:

```json
{
  "point": {
    "color": "#0068B5",
    "radius": 7,
    "strokeColor": "#FFFFFF",
    "strokeWidth": 2,
    "cluster": true
  },
  "line": {
    "color": "#0068B5",
    "width": 3,
    "opacity": 0.9
  },
  "polygon": {
    "fillColor": "#DDEFFC",
    "fillOpacity": 0.35,
    "strokeColor": "#0068B5",
    "strokeWidth": 2
  }
}
```

Server allowlist key/value/range để ngăn style injection và expression quá phức tạp.

## 3. Authentication và tài khoản

### 3.1 Route summary

| Method    | Route                                               | Auth/role                          | Mô tả                                                               |
| --------- | --------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| GET       | `/auth/csrf`                                        | public/pre-auth/auth               | Cấp hoặc lấy token CSRF hiện tại; không rotate trong cùng session   |
| GET       | `/auth/bootstrap/status`                            | public                             | Chỉ trả bootstrap System Admin có available hay không               |
| POST      | `/auth/bootstrap/system-admin`                      | public + CSRF + bootstrap token    | Tạo đúng một System Admin đầu tiên, áp policy MFA hiện hành         |
| POST      | `/auth/login`                                       | public + CSRF                      | Xác minh username/email + password                                  |
| POST      | `/auth/mfa/verify`                                  | pre-auth + CSRF                    | Xác minh TOTP/recovery code, tạo session                            |
| POST      | `/auth/mfa/enroll`                                  | pre-auth + CSRF                    | Bắt đầu enroll TOTP; URI chỉ trả một lần cho pre-auth đó            |
| POST      | `/auth/mfa/enroll/confirm`                          | pre-auth + CSRF                    | Xác nhận TOTP lần đầu, trả recovery codes một lần                   |
| POST      | `/auth/mfa/recovery-codes:regenerate`               | authenticated + CSRF + idempotency | Xác minh password + MFA rồi thay toàn bộ recovery codes             |
| GET       | `/auth/me`                                          | authenticated                      | Principal hiện tại                                                  |
| POST      | `/auth/logout`                                      | authenticated                      | Thu hồi phiên hiện tại                                              |
| POST      | `/auth/sessions:revoke-all`                         | authenticated + CSRF + idempotency | Thu hồi mọi session, gồm session đang gọi                           |
| POST      | `/auth/password/change`                             | authenticated + CSRF + idempotency | Đổi password, rotate session hiện tại và revoke các session còn lại |
| POST      | `/auth/password/reset:request`                      | public + idempotency               | Luôn trả generic `202`, không tiết lộ account tồn tại               |
| POST      | `/auth/password/reset:confirm`                      | public + CSRF                      | Đặt password bằng token một lần chỉ nhận trong body                 |
| POST      | `/auth/invites:inspect`                             | public                             | Inspect invite an toàn, không tiêu thụ token                        |
| POST      | `/auth/invites:accept`                              | public                             | Đặt password, tiêu thụ invite và áp policy MFA hiện hành            |
| GET/POST  | `/admin/users`                                      | System Admin                       | Danh sách/tạo user                                                  |
| GET/PATCH | `/admin/users/{userId}`                             | System Admin                       | Xem/cập nhật/khóa user                                              |
| POST      | `/admin/invites`                                    | System Admin                       | Tạo invite                                                          |
| GET       | `/admin/invites`                                    | System Admin                       | Danh sách invite theo cursor/search/status/role                     |
| POST      | `/admin/invites/{inviteId}:revoke`                  | System Admin                       | Thu hồi invite                                                      |
| POST      | `/admin/invites/{inviteId}:resend`                  | System Admin + CSRF + ETag         | Thay invite cũ bằng credential mới và gửi mail                      |
| POST      | `/admin/users/{userId}/sessions/{sessionId}:revoke` | System Admin + CSRF + ETag         | Thu hồi một session của user đích                                   |
| POST      | `/admin/users/{userId}/sessions:revoke-all`         | System Admin + CSRF + ETag         | Thu hồi mọi session của user đích                                   |
| POST      | `/admin/users/{userId}/mfa:reset`                   | System Admin                       | Thu hồi MFA/session và bắt buộc re-enroll                           |
| POST      | `/admin/users/{userId}/password-reset:request`      | System Admin + CSRF + ETag         | Gửi mail reset, không trả credential                                |
| POST      | `/admin/user-imports`                               | System Admin                       | Upload và inspect danh sách user                                    |
| GET       | `/admin/user-imports/{jobId}`                       | System Admin                       | Theo dõi inspect/validate/apply                                     |
| POST      | `/admin/user-imports/{jobId}:validate`              | System Admin                       | Dry-run duplicate/validation                                        |
| POST      | `/admin/user-imports/{jobId}:apply`                 | System Admin                       | Tạo account invite/inactive idempotent                              |
| GET       | `/admin/user-imports/{jobId}/report`                | System Admin                       | Tải report đã lọc                                                   |

### 3.2 Login và MFA

Database mới không có default credential hoặc production seed. Khi operator đã cấu hình
`INITIAL_ADMIN_BOOTSTRAP_TOKEN` ngẫu nhiên tối thiểu 43 ký tự, client gọi:

`GET /api/v1/auth/bootstrap/status`

Response `200` chỉ có một field nghiệp vụ (ngoài envelope meta chung):

```json
{ "data": { "available": true } }
```

`available=false` khi token không được cấu hình hoặc bảng `users` không còn rỗng. Token cấu hình
không bao giờ xuất hiện trong status/response/log/audit. Khi available, client lấy CSRF qua
`GET /auth/csrf`, gửi credentialed same-origin request với `Origin`, `X-CSRF-Token` và header bí mật
`X-Initial-Admin-Bootstrap-Token`:

`POST /api/v1/auth/bootstrap/system-admin`

```json
{
  "email": "admin@example.gov.vn",
  "username": "system.admin",
  "displayName": "Quản trị hệ thống",
  "password": "<redacted>",
  "passwordConfirmation": "<redacted>"
}
```

Password dài 14-200 ký tự, có chữ thường, chữ hoa, số và ký tự đặc biệt, đồng thời không chứa
username hoặc local-part của email. Server rate-limit trước khi so token constant-time. Transaction
PostgreSQL giữ advisory lock rồi chỉ insert khi `users` rỗng; hai request đồng thời có đúng một
response `201`, request thua và mọi replay trả `409 BOOTSTRAP_ALREADY_COMPLETED`. Thành công trả cùng
`loginResult` như login: policy bật trả pre-auth với `mfaEnrollmentRequired=true`; policy tắt trả
authenticated session trực tiếp. Bootstrap token không quyết định policy MFA.

Error codes typed: `BOOTSTRAP_TOKEN_INVALID` (401), `CSRF_INVALID` (403),
`BOOTSTRAP_ALREADY_COMPLETED` (409), `VALIDATION_FAILED|BOOTSTRAP_PASSWORD_WEAK` (422),
`RATE_LIMITED` (429), `BOOTSTRAP_UNAVAILABLE|AUTH_RATE_LIMIT_UNAVAILABLE` (503). Audit chỉ ghi
outcome/reason đã redacted; password, bootstrap token, TOTP secret và recovery codes không được ghi.

Trước `POST /auth/login`, client gọi `GET /auth/csrf`, giữ cookie `danangmap_csrf`, rồi echo giá trị cookie đã được browser chốt trong `X-CSRF-Token` và gửi `Origin` hợp lệ. Quy tắc tương tự áp dụng cho `mfa/verify`, `mfa/enroll` và `mfa/enroll/confirm`. Sau khi public cookie đã được thiết lập, các GET lặp lại reuse token đó; trong cùng pre-auth/authenticated session, các GET đồng thời hoặc lặp lại luôn trả cùng token. Client chỉ dùng token mới sau trust transition public → pre-auth → authenticated hoặc khi server tạo/rotate session mới tại password/session-security boundary.

`POST /api/v1/auth/login`

```json
{
  "login": "editor@example.gov.vn",
  "password": "<redacted>"
}
```

Response `200`:

```json
{
  "data": {
    "status": "mfa_required",
    "mfaEnrollmentRequired": false,
    "challengeExpiresAt": "2026-08-20T18:35:00.000Z"
  }
}
```

Khi `MFA_ENABLED=false` (mặc định), login/bootstrap/invite-accept trả authenticated cookie và:

```json
{
  "data": {
    "status": "authenticated",
    "mfaEnrollmentRequired": false,
    "principal": {
      "id": "0192a70b-245c-7a32-9481-30f288e97415",
      "email": "editor@example.gov.vn",
      "username": "editor01",
      "displayName": "Biên tập viên 01",
      "role": "editor",
      "status": "active",
      "mfaEnabled": false,
      "mustChangePassword": false
    }
  }
}
```

Các endpoint enroll/verify/regenerate/admin-reset MFA trả `409 MFA_DISABLED` khi policy tắt. Factor và
recovery code đã lưu không bị xóa; bật lại policy sẽ tiếp tục dùng factor đã xác minh hoặc yêu cầu enroll.

`POST /api/v1/auth/mfa/verify`

```json
{
  "method": "totp",
  "code": "000000"
}
```

Response tạo authenticated cookie và trả principal:

```json
{
  "data": {
    "id": "0192a70b-245c-7a32-9481-30f288e97415",
    "email": "editor@example.gov.vn",
    "username": "editor01",
    "displayName": "Biên tập viên 01",
    "role": "editor",
    "mfaEnabled": true
  }
}
```

Không trả field phân biệt “user không tồn tại” và “password sai”. Recovery code chỉ dùng một lần.

Khi login trả `mfaEnrollmentRequired=true`, client gọi `POST /api/v1/auth/mfa/enroll` với body rỗng. Response `200` duy nhất cho pre-auth hiện tại:

```json
{
  "data": {
    "status": "pending",
    "enrollmentUri": "otpauth://totp/DanangMap:editor%40example.gov.vn?secret=<redacted>&issuer=DanangMap"
  }
}
```

URI/secret chỉ được trả đúng một lần cho mỗi pre-auth. Replay tuần tự hoặc request start đồng thời thua race trả `409 AUTH_MFA_ENROLLMENT_ALREADY_STARTED` và không có URI/secret. Nếu response bị mất hoặc tab đóng, user login bằng password lại để nhận pre-auth mới; backend rotate pending secret/challenge, làm pre-auth/challenge cũ vô hiệu. Confirm bằng cookie cũ trả `409 AUTH_MFA_ENROLLMENT_STALE`.

`enrollment_session_id` là liên kết nội bộ giữa pending factor và pre-auth session; không phải request/response/header public. `POST /api/v1/auth/mfa/enroll/confirm` tiếp tục nhận body tối thiểu:

```json
{ "code": "000000" }
```

Backend bind pending factor với `principal.sessionId` của pre-auth cookie, xác minh TOTP, bật MFA, tạo authenticated session, revoke pre-auth và trả principal cùng 10 recovery codes đúng một lần:

```json
{
  "data": {
    "principal": {
      "id": "0192a70b-245c-7a32-9481-30f288e97415",
      "email": "editor@example.gov.vn",
      "username": "editor01",
      "displayName": "Biên tập viên 01",
      "role": "editor",
      "mfaEnabled": true
    },
    "recoveryCodes": [
      "A1B2-C3D4-E5F6-0718-192A",
      "B2C3-D4E5-F607-1829-A3B4",
      "C3D4-E5F6-0718-29A3-B4C5",
      "D4E5-F607-1829-A3B4-C5D6",
      "E5F6-0718-29A3-B4C5-D6E7",
      "F607-1829-A3B4-C5D6-E7F8",
      "0718-29A3-B4C5-D6E7-F809",
      "1829-A3B4-C5D6-E7F8-091A",
      "29A3-B4C5-D6E7-F809-1A2B",
      "A3B4-C5D6-E7F8-091A-2B3C"
    ]
  }
}
```

Hai confirm đồng thời chỉ có một request thành công. Replay TOTP cùng time-step và recovery code đã dùng bị từ chối. DB chỉ lưu digest recovery code; enrollment URI, raw TOTP secret và raw recovery code không xuất hiện trong audit/problem/log output. Confirm sai liên tiếp bị rate limit; pre-auth hết hạn không được start/confirm.

Regenerate recovery codes yêu cầu body `{ "password": "<redacted>", "mfaCode": "000000" }`; response trả mảng recovery code đúng một lần, đồng thời vô hiệu toàn bộ code cũ. System Admin reset MFA không nhận/biết secret hoặc recovery code của user; command revoke toàn bộ session và lần login sau trả `mfaEnrollmentRequired=true`.

### 3.3 Tạo và quản trị user

`POST /api/v1/admin/users`

```json
{
  "email": "reviewer@example.gov.vn",
  "username": "reviewer01",
  "displayName": "Kiểm duyệt viên 01",
  "role": "reviewer",
  "delivery": "invite"
}
```

`role`: đúng một trong `system_admin|editor|reviewer|publisher`. `delivery=invite` gửi link thiết lập mật khẩu. `delivery=manual` yêu cầu field `temporaryPassword`, đặt `mustChangePassword=true` và truyền mật khẩu qua kênh vận hành an toàn; API không bao giờ trả lại password. Guard trung tâm trả `403 PASSWORD_CHANGE_REQUIRED` cho mọi route admin/domain cho đến khi user đổi mật khẩu; chỉ các route auth tối thiểu cần để xem principal, lấy CSRF, đổi mật khẩu và logout được phép trong trạng thái này.

`GET /api/v1/admin/users` hỗ trợ `q`, `role`, `status`, `cursor`, `limit` và trả directory an toàn. `GET /api/v1/admin/users/{userId}` trả hồ sơ cùng summary MFA, session, invite và password-reset; response có strong `ETag` dạng `"user-{uuid}-v{lockVersion}"`. Representation không chứa password hash, session token/hash, MFA secret, recovery code/digest, invite/reset token hay encrypted mail payload.

`PATCH /api/v1/admin/users/{userId}` nhận full hoặc partial `{ "displayName", "role", "status", "reason" }`. Đổi role/status bắt buộc `reason`; đổi role, disable hoặc reactivate revoke toàn bộ authenticated/pre-auth session trong cùng transaction. System Admin cuối cùng ở trạng thái active không thể bị demote/disable. Các security mutation nhắm chính actor bị chặn để actor dùng self-service flow tương ứng.

Các mutation quản trị user/invite mới bắt buộc cookie session, CSRF + Origin, UUID `Idempotency-Key` và `If-Match` vừa nhận từ detail/list. Thiếu validator trả `428 ETAG_REQUIRED`; stale/malformed trả `412 ETAG_MISMATCH`; validation trả `422`; command đồng thời chỉ một effect và replay cùng key/body trả receipt cũ. Rate limit trả `429` theo actor/target và không tiết lộ credential.

`POST /api/v1/admin/invites`

```json
{
  "email": "reviewer@example.gov.vn",
  "username": "reviewer01",
  "displayName": "Kiểm duyệt viên 01",
  "role": "reviewer",
  "expiresInHours": 72
}
```

Response `202` trả invite ID/status/expiry nhưng không trả raw token. Token được mail adapter gửi qua outbox có retry; retry command cùng `Idempotency-Key` không tạo nhiều invite/mail. Revoke và tạo invite mới làm token cũ vô hiệu.

`GET /api/v1/admin/invites` hỗ trợ `q`, `status=pending|expired|revoked|accepted`, `role`, cursor và limit. `POST /api/v1/admin/invites/{inviteId}:resend` nhận `{ "expiresInHours", "reason" }`, revoke và scrub mail credential cũ, tạo replacement invite mới rồi enqueue đúng một mail. Response `202` chỉ trả identity/status/expiry/mail status/ETag của replacement; token cũ không inspect/accept được và token mới không xuất hiện trong response/audit/log.

`POST /api/v1/admin/users/{userId}/mfa:reset` nhận `{ "reason": "Thiết bị MFA đã mất." }`; reason bắt buộc, response trả `mfaEnrollmentRequired=true` và số session đã revoke, không trả secret/code.

`POST /api/v1/admin/users/{userId}/sessions/{sessionId}:revoke` và `POST /api/v1/admin/users/{userId}/sessions:revoke-all` nhận `reason`, chỉ cập nhật session thuộc đúng target và trả số session đã revoke cùng ETag mới. `POST /api/v1/admin/users/{userId}/password-reset:request` enqueue mail transactionally, trả `202` với outbox identity/status/expiry an toàn nhưng không trả reset token. System Admin không thể generate recovery code thay user.

Import user dùng multipart `file`, format CSV/XLSX, cột tối thiểu `email,username,displayName,role`; không cho import password/MFA secret. Mặc định tối đa 5 MiB/5.000 dòng. Validate không tạo account; apply yêu cầu `Idempotency-Key` và body `{ "validRowPolicy": "invite" }`, tạo account hợp lệ ở trạng thái invite/inactive và giữ report lỗi.

### 3.4 Invite và password reset

`POST /api/v1/auth/invites:inspect` nhận `{ "token": "<one-time-token>" }` và chỉ trả email đã mask, role, expiry, `requiresMfaEnrollment`; token không nằm trong URL/log access. Token invalid/expired/used đều trả cùng lỗi `INVITE_INVALID_OR_EXPIRED`.

`POST /api/v1/auth/invites:accept`

```json
{
  "token": "<one-time-token>",
  "password": "<redacted>",
  "passwordConfirmation": "<redacted>"
}
```

Response tạo pre-auth challenge để gọi `/auth/mfa/enroll`; invite bị tiêu thụ nguyên tử. Replay bị từ chối.

`POST /api/v1/auth/password/reset:request`

```json
{ "email": "user@example.gov.vn" }
```

Yêu cầu `Idempotency-Key`. Email có và không có account đều trả cùng generic `202 { "status": "accepted" }` trong cùng lớp timing; rate limit áp dụng theo IP + account hash cho owner đầu tiên của command. Retry cùng key/payload đọc durable receipt, kể cả sau khi API restart, không tiêu thụ thêm rate-limit slot và không tạo thêm outbox; cùng key khác payload trả `409 IDEMPOTENCY_KEY_REUSED`. Mail adapter gửi token random một lần qua outbox; DB chỉ lưu hash, mặc định hết hạn sau 30 phút và token mới revoke token cũ.

Token reset được người dùng copy/paste từ kênh mail vào form và chỉ truyền trong JSON body. Client không đưa token vào path/query/fragment URL, browser storage, analytics hoặc log; server không lưu token thô trong DB, receipt hay audit.

`POST /api/v1/auth/password/reset:confirm`

```json
{
  "token": "<one-time-token>",
  "password": "<redacted>",
  "passwordConfirmation": "<redacted>"
}
```

Client phải lấy CSRF qua `GET /api/v1/auth/csrf`; confirm yêu cầu `X-CSRF-Token` và Origin/Referer hợp lệ. Thành công consume token nguyên tử, đổi password, revoke toàn bộ authenticated/pre-auth session, pending challenge và reset token, xóa auth cookie, rồi trả `{ "status": "password_reset", "loginRequired": true, "sessionsRevoked": 2 }`. User phải login + MFA lại. Token invalid/expired/revoked/used và concurrent loser đều dùng `PASSWORD_RESET_INVALID_OR_EXPIRED`, không tiết lộ trạng thái account.

### 3.5 Đổi password và revoke session

`POST /api/v1/auth/password/change`

```json
{
  "currentPassword": "<redacted>",
  "newPassword": "<redacted>",
  "passwordConfirmation": "<redacted>"
}
```

Yêu cầu authenticated cookie, `X-CSRF-Token`, Origin/Referer hợp lệ và `Idempotency-Key`. Server đổi password, xóa `mustChangePassword`, revoke session hiện tại cùng mọi session khác, rồi tạo đúng một session/CSRF mới cho response sở hữu transaction. Response `200` trả `status=password_changed`, `sessionsRevoked`, `sessionRotated=true` và principal; không trả session token trong JSON.

Hai request concurrent cùng key/payload chỉ có một effect; chỉ response sở hữu transaction được nhận cookie mới. Retry tuần tự bằng cookie cũ sau khi rotation phải trả `401 AUTH_SESSION_EXPIRED`, không replay cookie hoặc response thành công. Cùng key khác payload trả `409 IDEMPOTENCY_KEY_REUSED`.

`POST /api/v1/auth/sessions:revoke-all` yêu cầu authenticated cookie, `X-CSRF-Token`, Origin/Referer hợp lệ và `Idempotency-Key`. Command revoke mọi session, bao gồm session đang gọi, xóa session/CSRF cookie và trả `revokedCount`, `currentSessionRevoked=true`, `loginRequired=true`. Vì cookie gọi đã chết, retry tuần tự bằng cookie cũ phải trả `401 AUTH_SESSION_EXPIRED`; concurrent cùng key vẫn chỉ có một effect.

## 4. Admin layer và schema

### 4.1 Route summary

| Method | Route                                         | Role      | Mô tả                                                                    |
| ------ | --------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| GET    | `/admin/layer-groups`                         | mọi admin | Liệt kê group theo display order                                         |
| POST   | `/admin/layer-groups`                         | Editor    | Tạo group                                                                |
| GET    | `/admin/layer-groups/{groupId}`               | mọi admin | Chi tiết group + ETag                                                    |
| PATCH  | `/admin/layer-groups/{groupId}`               | Editor    | Sửa metadata/order                                                       |
| POST   | `/admin/layer-groups:reorder`                 | Editor    | Atomically reorder group theo collection ETag                            |
| POST   | `/admin/layer-groups/{groupId}:archive`       | Editor    | Archive group, không xóa layer                                           |
| GET    | `/admin/layers`                               | mọi admin | Liệt kê layer                                                            |
| POST   | `/admin/layers`                               | Editor    | Tạo layer + draft đầu tiên                                               |
| GET    | `/admin/layers/{layerId}`                     | mọi admin | Chi tiết layer                                                           |
| PATCH  | `/admin/layers/{layerId}`                     | Editor    | Đổi group/order/default visibility theo resource ETag                    |
| POST   | `/admin/layers:reorder`                       | Editor    | Atomically reorder layer theo collection ETag                            |
| POST   | `/admin/layers/{layerId}:archive`             | Editor    | Archive mềm                                                              |
| POST   | `/admin/layers/{layerId}:unarchive`           | Editor    | Bỏ archive mềm nếu group tham chiếu còn active                           |
| GET    | `/admin/layers/{layerId}/revisions`           | mọi admin | Lịch sử revision                                                         |
| POST   | `/admin/layers/{layerId}/drafts`              | Editor    | Tạo draft từ snapshot active                                             |
| GET    | `/admin/revisions/{revisionId}`               | mọi admin | Chi tiết revision                                                        |
| POST   | `/admin/revisions/{revisionId}/config:impact` | Editor    | Preview ảnh hưởng của một full configuration replacement, không mutation |
| PUT    | `/admin/revisions/{revisionId}/config`        | Editor    | Atomically thay toàn bộ cấu hình của draft revision                      |
| GET    | `/admin/revisions/{revisionId}/workspace`     | mọi admin | Metadata sync workspace                                                  |
| GET    | `/admin/revisions/{revisionId}/features`      | mọi admin | Feature theo bbox/cursor                                                 |

### 4.2 Tạo layer

`POST /api/v1/admin/layers`

Header: `Idempotency-Key`.

```json
{
  "slug": "administrative-offices",
  "groupId": "0192a749-4f90-7d74-b2bf-96aa8c28ce41",
  "displayOrder": 20,
  "title": "Trụ sở hành chính",
  "description": "Vị trí các trụ sở hành chính trên địa bàn.",
  "geometryMode": "mixed",
  "allowedGeometryKinds": ["point", "polygon"],
  "fields": [
    {
      "key": "name",
      "label": "Tên",
      "type": "text",
      "required": true,
      "public": true,
      "searchable": true,
      "filterable": false,
      "sortable": true,
      "displayOrder": 10
    }
  ],
  "style": {
    "point": { "color": "#0068B5", "radius": 7, "cluster": true }
  },
  "renderConfig": {
    "minZoom": 8,
    "maxZoom": 18,
    "cluster": true,
    "sourcePolicy": "auto"
  },
  "popupConfig": {
    "titleField": "name",
    "fieldKeys": ["name", "address"],
    "showCoordinates": false
  }
}
```

`geometryMode`: `point|circle|polyline|polygon|mixed`. Mixed cần `allowedGeometryKinds`; các kind: `point|multipoint|line|multiline|polygon|multipolygon|circle`.

Response `201` trả layer và draft revision. `slug` không thay đổi sau khi public nếu chưa có migration/redirect riêng.

Layer group là cấu trúc trình bày, không phải permission boundary. Group DTO gồm `id`, `slug`, `title`, `description`, `displayOrder`, `archivedAt`. `groupId` có thể null. Archive group yêu cầu `If-Match`, `Idempotency-Key` và body `{ "orphanLayerPolicy": "ungroup" }`. Cùng transaction archive group, server đặt `groupId=null` cho mọi layer con; không archive/xóa layer, không thay revision/publication snapshot của layer. Replay cùng key/payload trả cùng kết quả/ETag và audit event chỉ ghi một lần.

Canonical lock order cho mọi race group→layer là **active group trước, layer sau**. Create/move/unarchive layer tham chiếu group phải giữ read lock trên group active trước khi insert hoặc write-lock layer; archive group giữ write lock trên group rồi atomically ungroup các layer con. Nếu archive chạy đồng thời create/move/unarchive, operation thắng race có thể thành công và operation còn lại có thể trả 404/412, nhưng state commit cuối cùng tuyệt đối không được có layer tham chiếu group archived. Reorder collection lock các row active theo thứ tự ID ổn định, validate collection ETag sau khi lock và update trong một transaction.

Audit catalog không lưu danh sách ID/order có cardinality lớn. Group archive chỉ ghi `orphanLayerPolicy`, `ungroupedLayerCount` và SHA-256 digest của danh sách layer ID canonical đã sort; reorder ghi count + digest của order state trước/sau. `beforeDigest`/`afterDigest` vẫn cho phép đối soát nhưng metadata giữ kích thước bounded và không chứa raw feature/property/private value.

`popupConfig` được version hóa cùng revision. Chỉ chấp nhận key allowlist như `titleField`, `subtitleField`, `fieldKeys`, `showCoordinates`; mọi field tham chiếu phải tồn tại. Public projection tự loại field private/sensitive khỏi popup kể cả config cũ còn tham chiếu.

`renderConfig.sourcePolicy`: `auto|geojson|mvt|hybrid`. Publication builder có thể hạ `auto` thành source descriptor cụ thể dựa trên benchmark/feature count nhưng không được đổi canonical data; min/max zoom và cluster được validate theo geometry/style.

### 4.3 Atomic draft configuration

Hai route cấu hình dùng cùng `RevisionConfiguration` DTO đầy đủ gồm `title`, `description`, `geometryMode`, `allowedGeometryKinds`, `fields`, `style`, `renderConfig` và `popupConfig`. Identity/catalog metadata (`slug`, `groupId`, `displayOrder`, `defaultVisible`) không thuộc DTO này và được quản lý bởi route layer/catalog. Không tồn tại route PATCH cấu hình revision hoặc route thay fields riêng song song.

`POST /api/v1/admin/revisions/{revisionId}/config:impact` yêu cầu `If-Match`, authenticated Editor, CSRF và Origin/Referer hợp lệ. Route chỉ tính toán, không mutation và không tăng `lockVersion`/`schemaVersion`. Response `200` trả:

```json
{
  "featureCount": 18420,
  "blocking": true,
  "schemaVersionWillIncrement": true,
  "reasons": [
    {
      "code": "FIELD_REMOVAL_WITH_DATA",
      "fieldKey": "phone",
      "geometryKind": null,
      "affectedFeatures": 176
    }
  ]
}
```

Reason code cố định: `GEOMETRY_KIND_IN_USE`, `FIELD_REMOVAL_WITH_DATA`, `FIELD_CONSTRAINT_CHANGE_WITH_DATA`, `REQUIRED_FIELD_MISSING`. Response giữ nguyên ETag hiện tại để client dùng cho lệnh replace tiếp theo.

Impact phải **value-aware** trên toàn bộ feature link hiện có, không được đánh đồng mọi thay đổi constraint/options với breaking change. Server dùng aggregate set-based để đếm đúng các value hiện tại vi phạm type, string length, numeric/integer range, enum/multi-enum allow-list hoặc required rule mới. Nới range, tăng max length hay bổ sung enum option trả `blocking=false` nếu không có value vi phạm; siết constraint chỉ tạo `FIELD_CONSTRAINT_CHANGE_WITH_DATA` cho số feature thực sự không hợp lệ.

Output được bounded và deterministic: tối đa theo allow-list geometry và tối đa 100 field trong DTO; mỗi reason chỉ trả code, `fieldKey`/`geometryKind` và aggregate `affectedFeatures`, sort canonical, không trả feature ID hoặc raw value. `null` không vi phạm constraint thường nhưng được tính là missing khi field required; remove field có property hiện hữu và remove geometry kind đang dùng vẫn là blocking.

`PUT /api/v1/admin/revisions/{revisionId}/config` yêu cầu `If-Match`, `Idempotency-Key`, authenticated Editor, CSRF và Origin/Referer hợp lệ. Server validate toàn bộ geometry/schema/style/render/popup trong một boundary rồi atomically thay toàn bộ cấu hình và fields của draft. Không được để client quan sát trạng thái trung gian giữa các phần cấu hình.

- Chỉ revision `draft` được sửa; `in_review`, `approved`, `published` và revision lịch sử trả `409 REVISION_NOT_EDITABLE`.
- Impact có `blocking=true` làm replace trả `422 CONFIG_IMPACT_BLOCKED`, kèm impact trong error details; không mutation một phần.
- Thành công trả revision, fields, impact và ETag mới; `schemaVersion` chỉ tăng khi geometry/schema signature thay đổi, `lockVersion` tăng một lần.
- Thiếu `If-Match` trả `428 ETAG_REQUIRED`, stale ETag trả `412 ETAG_MISMATCH`.
- Replay cùng idempotency key/payload trả cùng body/ETag và chỉ một audit event; cùng key khác payload trả `409 IDEMPOTENCY_KEY_REUSED`.
- Draft/config mới không xuất hiện ở public catalog/detail/data cho tới khi publication pointer chuyển thành công.

Successor draft tạo từ revision đang published phải copy cấu hình và feature links của source, giữ lineage `sourceRevisionId`/`supersedesRevisionId`, và tuân constraint một open editorial chain trên mỗi layer. Mọi sửa tiếp theo vẫn đi qua atomic config replacement ở trên; source published không bị mutation.

Open editorial chain được khóa bằng DB partial unique invariant trên đúng bốn status `draft|in_review|approved|publishing`. Direct successor creation và request-changes đều lock layer trước khi chuyển/tạo revision; concurrent cross-path chỉ một command được tạo row open, command còn lại trả `409 DRAFT_ALREADY_EXISTS` và không để lại state nửa chừng. `changes_requested` và `published` là history immutable, không thuộc partial unique set.

Quyết định dùng một full replacement boundary để geometry policy, field schema, style và popup luôn được validate trên cùng một snapshot. Điều này tránh intermediate state không tương thích và giữ đúng một ETag/idempotency/audit boundary cho mỗi lần lưu.

### 4.4 Workspace

`GET /api/v1/admin/revisions/{revisionId}/workspace`

```json
{
  "data": {
    "revisionId": "0192a75a-ab97-7521-a940-42146868b385",
    "layerId": "0192a75a-61da-7cc2-9708-8ac54271db52",
    "status": "draft",
    "serverCursor": "cur_01J5...",
    "featureCount": 18420,
    "bounds": [108.01, 15.87, 108.45, 16.24],
    "schemaVersion": 4,
    "updatedAt": "2026-08-20T18:30:00.000Z"
  }
}
```

Response có `ETag: "rev-<id>-v<lockVersion>"`. Workspace không nhồi toàn bộ feature lớn; frontend tải feature qua bbox/cursor hoặc MVT draft preview.

### 4.5 Liệt kê feature admin

`GET /api/v1/admin/revisions/{revisionId}/features?bbox=108.0,15.8,108.5,16.3&cursor=...&limit=200&sort=name:asc&filter=status:eq:active`

- `bbox` tùy chọn nhưng bắt buộc nếu layer vượt ngưỡng full-list.
- `sort=<fieldKey>:asc|desc`; field phải `sortable`.
- `filter=<fieldKey>:<operator>:<url-encoded-value>` có thể lặp tối đa 10 lần.
- Operator: `eq`, `neq`, `in`, `gt`, `gte`, `lt`, `lte`, `contains`, `isnull` và phải tương thích type.

## 5. Feature editing và Dexie sync

### 5.1 Route summary

| Method | Route                                                | Role      | Mô tả                             |
| ------ | ---------------------------------------------------- | --------- | --------------------------------- |
| POST   | `/admin/revisions/{revisionId}/features`             | Editor    | Tạo một feature                   |
| GET    | `/admin/revisions/{revisionId}/features/{featureId}` | mọi admin | Đọc feature                       |
| PATCH  | `/admin/revisions/{revisionId}/features/{featureId}` | Editor    | Sửa geometry/properties           |
| DELETE | `/admin/revisions/{revisionId}/features/{featureId}` | Editor    | Xóa mềm khỏi draft                |
| POST   | `/admin/revisions/{revisionId}/changes:batch`        | Editor    | Đồng bộ batch mutation idempotent |
| GET    | `/admin/revisions/{revisionId}/changes`              | mọi admin | Pull change feed sau cursor       |
| POST   | `/admin/revisions/{revisionId}/conflicts:resolve`    | Editor    | Ghi lựa chọn resolve rõ ràng      |

### 5.2 Tạo feature

`POST /api/v1/admin/revisions/{revisionId}/features`

Header: `If-Match`, `Idempotency-Key`.

```json
{
  "geometry": {
    "type": "Point",
    "coordinates": [108.2208, 16.0678]
  },
  "geometryKind": "circle",
  "radiusM": 250,
  "externalSource": "danang-legacy",
  "externalId": "office-buffer-001",
  "properties": {
    "name": "Vùng phục vụ mẫu"
  }
}
```

Response `201` chứa feature UUID do server tạo, versionId, serverCursor và ETag mới. Client không gửi canonical `id` khi tạo.

Giới hạn mutation trực tiếp giống import: tối đa 100.000 vertex/feature và `properties` tối đa 64 KiB sau UTF-8 JSON serialization; vượt giới hạn trả 422 `RESOURCE_LIMIT_EXCEEDED`. Circle HTTP luôn là `geometry.type=Point` + `geometryKind=circle` + `radiusM`; MultiPoint không hợp lệ cho circle. Tên cột Postgres tương ứng là `radius_m`, không phải field JSON.

### 5.3 Batch sync

`POST /api/v1/admin/revisions/{revisionId}/changes:batch`

Header: `If-Match` là workspace ETag khi bắt đầu batch. Batch tối đa 100 mutation hoặc 2 MiB.

```json
{
  "clientId": "0192a793-f096-78f6-bad8-e18b9452f8c9",
  "origin": "recovery",
  "baseCursor": "cur_01J5ABC",
  "mutations": [
    {
      "clientMutationId": "0192a794-1f84-79a5-95e2-60a888c591cd",
      "operation": "create",
      "baseRevisionVersion": 7,
      "payloadHash": "95922923a60b2dfb9b5e764ed410d63d0e027426bcd39859a5f48d5844e60a6e",
      "clientFeatureId": "0192a794-2eb0-7ab6-86d0-64aa90a6a2b8",
      "feature": {
        "geometry": {
          "type": "Point",
          "coordinates": [108.2208, 16.0678]
        },
        "geometryKind": "point",
        "radiusM": null,
        "properties": { "name": "Trụ sở mới" }
      }
    },
    {
      "clientMutationId": "0192a794-5d70-71c1-a28f-e034fd2a6c8b",
      "operation": "update",
      "baseRevisionVersion": 7,
      "payloadHash": "20f3daed23b62efd9e6ab4cb346d0db51c998ee1b342c0939614bbcaaf742d83",
      "featureId": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
      "baseVersionId": "0192a6c1-5bb4-7bc0-8376-c8d69bcd2f37",
      "patch": {
        "properties": { "phone": "0236 000 0000" }
      }
    }
  ]
}
```

`clientId`, `clientMutationId` và `clientFeatureId` là UUID ổn định do client tạo; chúng không phải credential. `baseRevisionVersion` của từng mutation phải bằng version trong `If-Match`. `payloadHash` là SHA-256 chữ thường của canonical JSON mutation sau khi bỏ chính field `payloadHash`: key object sắp xếp tăng dần đệ quy, array giữ nguyên thứ tự, UTF-8, JSON compact. `baseCursor` phải nằm trong cửa sổ retention hiện tại.

`origin`: `editor|recovery`; server ghi audit cho batch recovery. Backend không cấp editor lease. Web Locks/Dexie lease chỉ phối hợp tab trên một browser; mọi client vẫn phải dùng optimistic version/ETag.

`operation`: `create|update|delete`. Update dùng merge patch ở mức `geometry`, `geometryKind`, `radiusM`, `externalSource`, `externalId`, `properties`; muốn xóa property gửi `null` nếu schema cho phép hoặc dùng `unsetProperties`. Nếu có external identity thì cả `externalSource` và `externalId` bắt buộc; cặp này unique trong layer.

Response `200`:

```json
{
  "data": {
    "serverCursor": "cur_01J5ABD",
    "results": [
      {
        "clientMutationId": "0192a794-1f84-79a5-95e2-60a888c591cd",
        "status": "applied",
        "operation": "create",
        "clientFeatureId": "0192a794-2eb0-7ab6-86d0-64aa90a6a2b8",
        "canonicalFeatureId": "0192a79a-74eb-7221-aa2b-3dc4ae326ec9",
        "versionId": "0192a79a-af0d-78e1-883a-c555f1a16107",
        "serverCursor": "cur_01J5ABD"
      },
      {
        "clientMutationId": "0192a794-5d70-71c1-a28f-e034fd2a6c8b",
        "status": "conflict",
        "operation": "update",
        "canonicalFeatureId": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
        "serverCursor": "cur_01J5ABD",
        "conflict": {
          "code": "FEATURE_VERSION_CHANGED",
          "currentVersionId": "0192a79a-60ce-7891-9b53-042c34ec352a",
          "changedPaths": ["properties.phone"]
        }
      }
    ]
  }
}
```

Một mutation được reject/conflict không làm rollback mutation độc lập khác; response luôn có result theo đúng thứ tự request. Mỗi result là `applied|conflict|rejected` và luôn có cursor quan sát được. Retry cùng `(revisionId, clientId, clientMutationId)` và cùng payload trả lại nguyên kết quả durable cũ kể cả sau API restart và không yêu cầu ETag cũ còn hiện hành; cùng ID nhưng payload khác trả 409 `IDEMPOTENCY_KEY_REUSED`. Hash caller sai trả 422 `SYNC_PAYLOAD_HASH_MISMATCH`; stale workspace trả 412 `ETAG_MISMATCH`; revision không còn draft trả 409 `REVISION_NOT_EDITABLE`.

### 5.4 Pull changes

`GET /api/v1/admin/revisions/{revisionId}/changes?after=cur_01J5ABC&limit=500`

```json
{
  "data": [
    {
      "serverCursor": "cur_01J5ABD",
      "operation": "update",
      "featureId": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
      "versionId": "0192a79a-60ce-7891-9b53-042c34ec352a",
      "changedPaths": ["properties.phone"],
      "actor": {
        "id": "0192a70b-245c-7a32-9481-30f288e97415",
        "displayName": "Biên tập viên 01"
      },
      "changedAt": "2026-08-20T18:31:00.000Z"
    }
  ],
  "meta": {
    "nextCursor": "cur_01J5ABD",
    "hasMore": false
  }
}
```

Feed được sắp xếp tăng dần theo server cursor, tối đa 500 item/page và không đổi thứ tự khi phân trang. Retention mặc định 10.000 change/revision, cấu hình bằng `FEATURE_SYNC_CHANGE_RETENTION` (100–1.000.000). Nếu cursor quá cũ, trả 409 `SYNC_CURSOR_EXPIRED`, `details.workspaceUrl`, `details.currentCursor` và `details.currentEtag`. Client fetch workspace/full needed viewport, giữ mutation local chưa ack và rebase có kiểm soát.

### 5.5 Resolve conflict

`POST /api/v1/admin/revisions/{revisionId}/conflicts:resolve`

Header: `If-Match`, `Idempotency-Key`.

```json
{
  "origin": "recovery",
  "clientId": "browser-0192a793",
  "clientMutationId": "0192a8e4-680e-7ed1-ae66-b35c0bedef89",
  "featureId": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
  "baseVersionId": "0192a6c1-5bb4-7bc0-8376-c8d69bcd2f37",
  "currentVersionId": "0192a79a-60ce-7891-9b53-042c34ec352a",
  "strategy": "apply_explicit",
  "resolvedFeature": {
    "geometry": { "type": "Point", "coordinates": [108.2208, 16.0678] },
    "geometryKind": "point",
    "radiusM": null,
    "properties": { "name": "Trụ sở đã đối chiếu" }
  }
}
```

`strategy`: `keep_server|apply_explicit`. `keep_server` không cần `resolvedFeature`; `apply_explicit` bắt buộc payload đầy đủ đã được user xác nhận. Server không auto-merge geometry. Response trả `status`, `canonicalFeatureId`, `versionId`, `serverCursor`, workspace `ETag`; stale `currentVersionId` tiếp tục trả 409 `SYNC_CONFLICT`.

Logout chủ động trả `meta.recoveryAction="delete"`; frontend xóa các record Dexie của principal mà không ảnh hưởng preference công khai của origin. Session expiry trả 401 với `details.recoveryAction="lock"`; recovery chỉ mở lại sau khi cùng principal re-auth, không được hiện metadata cho user khác.

## 6. Attachment và image

| Method | Route                                                                           | Role                | Mô tả                                                         |
| ------ | ------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------- |
| POST   | `/admin/uploads`                                                                | Editor/System Admin | Tạo upload intent cho feature attachment                      |
| POST   | `/admin/uploads/{uploadId}:complete`                                            | chủ upload          | Xác nhận upload/checksum                                      |
| GET    | `/admin/attachments/{attachmentId}`                                             | admin               | Metadata/status                                               |
| DELETE | `/admin/attachments/{attachmentId}`                                             | chủ upload          | Xóa object chưa bind                                          |
| POST   | `/admin/revisions/{revisionId}/features/{featureId}/attachments:bind`           | Editor/System Admin | Bind attachment vào field versioned                           |
| PATCH  | `/admin/revisions/{revisionId}/features/{featureId}/attachments:reorder`        | Editor/System Admin | Đổi display order và tạo feature version mới                  |
| DELETE | `/admin/revisions/{revisionId}/features/{featureId}/attachments/{attachmentId}` | Editor/System Admin | Unbind và tạo feature version mới                             |
| GET    | `/public/attachments/{attachmentId}`                                            | public              | Đọc attachment chỉ khi thuộc field public của snapshot active |

`POST /api/v1/admin/uploads`

```json
{
  "purpose": "feature_attachment",
  "fileName": "tru-so.jpg",
  "contentType": "image/jpeg",
  "sizeBytes": 483920,
  "sha256": "f2ca1bb6c7e907d06dafe4687e579fce..."
}
```

Response có presigned `PUT` URL MinIO TTL mặc định 600 giây và đúng tập required headers; URL chứa quarantine key bất khả đoán do server sinh nhưng không phải public delivery URL. Client upload đúng bytes/MIME rồi gọi `:complete`; response `202` chuyển object sang `pending`, worker kiểm tra lại checksum và malware scan trước khi copy sang immutable final key và chuyển `clean`. `ATTACHMENT_UPLOAD_INCOMPLETE` có thể retry trong TTL; mismatch/expired bị reject. Binary không đi qua Dexie lâu dài.

Bind/reorder/unbind yêu cầu `If-Match`, UUID `Idempotency-Key`, CSRF và body tương ứng. Bind body:

```json
{
  "fieldKey": "images",
  "attachmentId": "0192a8ff-4969-7561-9b3f-9b987e6e2c10",
  "displayOrder": 10
}
```

Field phải có type `image|attachment`; field `image` chỉ nhận raster image đã allowlist và object bắt buộc `clean`. Bind/unbind/reorder tạo `feature_version_attachments` mới cùng feature version; không sửa association của version cũ. Canonical field value là danh sách attachment ID có thứ tự được materialize từ association, không nhận raw object key/URL từ `properties`. Feature response trả `attachments[]` gồm ID, fieldKey, displayOrder, fileName, contentType, sizeBytes và trạng thái; public projection chỉ trả association `clean` thuộc field `public=true`, `sensitive=false` của active snapshot. Public binary route re-authorize mỗi request, hỗ trợ ETag/304, trả `nosniff` và `Content-Disposition`; raw MinIO key/final URL không xuất hiện trong metadata. Attachment orphan chưa từng bind được worker xóa sau retention cấu hình; object từng được bất kỳ feature version nào tham chiếu không bị hard-delete bởi cleanup.

## 7. Import dữ liệu không gian

### 7.1 Route summary

| Method | Route                                   | Role   | Mô tả                                      |
| ------ | --------------------------------------- | ------ | ------------------------------------------ |
| POST   | `/admin/revisions/{revisionId}/imports` | Editor | Upload/tạo import job                      |
| GET    | `/admin/imports/{importId}`             | Editor | Status, progress, counts                   |
| PATCH  | `/admin/imports/{importId}/mapping`     | Editor | Chọn sheet/cột/CRS/field mapping/match key |
| POST   | `/admin/imports/{importId}:validate`    | Editor | Dry-run                                    |
| GET    | `/admin/imports/{importId}/issues`      | Editor | Issue cursor list                          |
| POST   | `/admin/imports/{importId}:apply`       | Editor | Apply vào draft                            |
| POST   | `/admin/imports/{importId}:cancel`      | Editor | Cancel khi còn hợp lệ                      |
| GET    | `/admin/imports/{importId}/report`      | Editor | Tải report CSV/JSON                        |

### 7.2 Tạo import

`POST /api/v1/admin/revisions/{revisionId}/imports`

Multipart:

- `file`: CSV/XLSX/GeoJSON/KML, tối đa chính xác 25 MiB (26.214.400 byte); file `.json` được sniff và chỉ nhận nếu validate như GeoJSON;
- `format`: `csv|xlsx|geojson|kml` hoặc bỏ để sniff an toàn;
- `mode`: `append|replace|upsert`;
- `clientRequestId`: UUID.

Headers: `If-Match`, `Idempotency-Key`, `X-CSRF-Token`.

Response `202`:

```json
{
  "data": {
    "id": "0192a7d3-cc02-7c52-a8e7-a05d1ae27e13",
    "status": "uploaded",
    "format": "xlsx",
    "mode": "upsert",
    "file": {
      "name": "tru-so.xlsx",
      "sizeBytes": 1183920
    },
    "progress": 0,
    "createdAt": "2026-08-20T18:30:00.000Z"
  }
}
```

### 7.3 Mapping

`PATCH /api/v1/admin/imports/{importId}/mapping`

```json
{
  "sheet": "DanhSach",
  "sourceCrs": "EPSG:4326",
  "geometry": {
    "kind": "coordinates",
    "longitudeColumn": "kinh_do",
    "latitudeColumn": "vi_do"
  },
  "fields": {
    "ten_tru_so": "name",
    "dia_chi": "address",
    "nguon": "external_source",
    "ma_ngoai": "external_id"
  },
  "unmappedColumnPolicy": "ignore",
  "upsert": {
    "matchBy": "external_identity"
  }
}
```

Geometry `kind`: `coordinates|wkt|geojson|kml_geometry`. `upsert.matchBy`: `feature_id|external_identity`. `external_identity` bắt buộc map cả `external_source` và `external_id`; cặp này unique trong layer. Nếu bỏ match key, upsert hoạt động như append, record được server tạo UUID mới và validation trả warning `UPSERT_WITHOUT_MATCH_KEY`. Không match mơ hồ theo arbitrary property/name/address.

### 7.4 Resource limits

- 100.000 record/feature/job.
- 100.000 vertex/feature; 2.000.000 vertex tổng/job.
- 250 MiB expanded/uncompressed input/job.
- Property payload tối đa 64 KiB/feature sau UTF-8 JSON serialization.
- XLSX tối đa 10 sheet, user chọn đúng một sheet/job và tối đa 256 cột.
- Database giữ tối đa 20.000 issue/job để phân trang; full report luôn lưu MinIO và endpoint report trả URL tải có TTL ngắn.

Các limit server có thể cấu hình thấp hơn theo môi trường. Tăng cao hơn baseline bắt buộc capacity review, soak test và migration/config review; API trả limit thực tế trong response inspect.

### 7.5 Validate và apply

`POST /api/v1/admin/imports/{importId}:validate` trả `202`; theo dõi bằng GET job.

Job ready:

```json
{
  "data": {
    "id": "0192a7d3-cc02-7c52-a8e7-a05d1ae27e13",
    "status": "ready",
    "progress": 100,
    "counts": {
      "total": 1000,
      "valid": 982,
      "warning": 8,
      "invalid": 18,
      "matched": 450,
      "new": 532
    },
    "canApplyWithSkipInvalid": true
  }
}
```

`POST /api/v1/admin/imports/{importId}:apply`

Headers: `If-Match`, `Idempotency-Key`.

```json
{
  "skipInvalid": true,
  "acknowledgedWarningCodes": ["FEATURE_OUTSIDE_DANANG"]
}
```

Response `202`. Nếu `skipInvalid=false` và có error, trả 422 `IMPORT_HAS_ERRORS`; không commit record nào. Với true, chỉ valid records được commit và report giữ các record skipped. Apply retry không tạo duplicate.

## 8. Workflow, publish và rollback

### 8.1 Route summary

| Method | Route                                           | Role      | Trạng thái nguồn |
| ------ | ----------------------------------------------- | --------- | ---------------- |
| POST   | `/admin/revisions/{revisionId}:submit`          | Editor    | draft            |
| POST   | `/admin/revisions/{revisionId}:request-changes` | Reviewer  | in_review        |
| POST   | `/admin/revisions/{revisionId}:approve`         | Reviewer  | in_review        |
| POST   | `/admin/revisions/{revisionId}:publish`         | Publisher | approved         |

Mọi command yêu cầu `Idempotency-Key`, CSRF và separation-of-duties check.

History/diff/rollback checkpoint có đúng chín endpoint canonical sau; alias cũ hoặc route tự suy đoán không thuộc contract:

| Method | Route                                           | Role         | Mô tả                                                                 |
| ------ | ----------------------------------------------- | ------------ | --------------------------------------------------------------------- |
| GET    | `/admin/layers/{layerId}/history`               | mọi admin    | Revision history cursor page                                          |
| GET    | `/admin/revisions/{revisionId}/history`         | mọi admin    | Revision, validation và bounded participant/event/publication summary |
| GET    | `/admin/revisions/{revisionId}/diff`            | mọi admin    | Feature-level diff với `compareTo=parent\|active`                     |
| GET    | `/admin/layers/{layerId}/publications`          | mọi admin    | Immutable publication history và rollback eligibility                 |
| GET    | `/admin/publications/{snapshotId}`              | mọi admin    | Chi tiết một publication snapshot                                     |
| GET    | `/admin/audit-events`                           | System Admin | Audit toàn hệ thống                                                   |
| GET    | `/admin/layers/{layerId}/audit-events`          | mọi admin    | Audit content theo layer và role scope                                |
| GET    | `/admin/revisions/{revisionId}/workflow-events` | mọi admin    | Workflow event cursor page                                            |
| POST   | `/admin/layers/{layerId}:rollback`              | Publisher    | Tạo rollback publication từ snapshot từng active                      |

Các GET history trả ETag của chính read model. `activePointerEtag` trong publication list/detail là token riêng cho active publication pointer; nó không phải layer ETag, revision ETag hoặc public catalog ETag.

### 8.2 Submit

`POST /api/v1/admin/revisions/{revisionId}:submit`

```json
{
  "summary": "Cập nhật 12 trụ sở sau sắp xếp hành chính.",
  "reviewerNote": "Đề nghị đối chiếu địa chỉ ở quận Hải Châu."
}
```

Response `202` nếu cần full validation; revision bị khóa ngay khi command được nhận. Validation fail trả trạng thái draft và report.

### 8.3 Request changes / approve

```json
{
  "comment": "Feature 3 thiếu số điện thoại và polygon 7 chưa hợp lệ."
}
```

Request changes bắt buộc comment. Approve có thể gửi `{ "comment": "Đã đối chiếu." }`. Actor không hợp lệ trả 403 `SEPARATION_OF_DUTIES` dù role hiện tại đúng.

Request changes giữ submitted revision gốc bất biến ở `changes_requested` và atomically tạo successor draft chứa bản sao logic của revision đó:

```json
{
  "data": {
    "originalRevisionId": "0192a75a-ab97-7521-a940-42146868b385",
    "draftRevisionId": "0192a95c-3af7-7db9-af8e-1b2e50102429",
    "supersedesRevisionId": "0192a75a-ab97-7521-a940-42146868b385",
    "originalStatus": "changes_requested",
    "draftStatus": "draft"
  }
}
```

Layer chỉ có một open editorial chain qua `draft|in_review|approved|publishing`, không chỉ một active draft. Nếu chain khác đã mở, command trả 409 `DRAFT_ALREADY_EXISTS` và không đổi trạng thái revision gốc. Request-changes atomically chuyển revision gốc sang `changes_requested` rồi tạo successor `draft` trong cùng lineage; successor là resource mới, không chuyển revision submitted trở lại editable.

### 8.4 Publish

`POST /api/v1/admin/revisions/{revisionId}:publish`

```json
{
  "releaseNote": "Xuất bản dữ liệu trụ sở tháng 08/2026.",
  "clientIntent": "desktop"
}
```

Response `202`:

```json
{
  "data": {
    "publicationId": "0192a82e-5e77-7b13-a332-45229d9813bb",
    "snapshotId": "0192a82e-5e77-7b13-a332-45229d9813bb",
    "generation": 8,
    "status": "completed"
  }
}
```

Mặc định `ASYNC_PUBLICATION_ENABLED=false`, publish giữ nguyên đường **đồng bộ** trong một transaction: HTTP request chỉ trả sau khi snapshot, pointer, revision state, participant, workflow event, audit và idempotency receipt đã commit. Trong lúc POST còn chạy, client chỉ hiển thị trạng thái indeterminate; không có publication ID đã commit để polling và không được dựng phần trăm giả. Ở chế độ này `clientIntent` chưa bắt buộc để giữ tương thích contract hiện hữu. Production chỉ bật async khi đặt explicit `ASYNC_PUBLICATION_ENABLED=true`; schema, `.env.example` và Compose không tự bật. Local production activation gate đã pass independent review nhưng không đổi default hay tự tạo release GO.

Khi bật cờ thử nghiệm, `clientIntent="desktop"` là bắt buộc và được kiểm tra trước transaction. Admission commit atomically receipt, lock/precondition/SoD, revision `publishing`, durable `publication_jobs` row trạng thái `queued`, outbox, workflow event và audit; sau đó trả `202` với job representation, `Location`, `ETag`, `Retry-After` và `Cache-Control: private, no-store`. Cùng idempotency key/body replay đúng response + ETag; key/body khác trả 409. Worker claim lease trong Postgres, đo feature/vertex thật, persist public-only UUID-keyset batches, resume checkpoint, recheck actor/role/SoD/fingerprint/base pointer và chỉ đổi pointer trong final transaction ngắn. Failure ổn định đưa revision về `approved`; Redis loss/lease expiry được reconcile; duplicate delivery hoặc crash sau final commit là no-op. Backend barrier hook chỉ được chấp nhận với `NODE_ENV=test`; filesystem phase/seed controls chỉ được wire trong exact E2E Compose, không phải HTTP contract production. Local production activation tại exact backend `2d4675ec2385abf55fa23ad26914e037456f14cd` + frontend `6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8` đã pass independent artifact review: hai fresh-volume run, 18/18 Playwright invocation, zero failed/skipped/flaky, production API/canonical worker với trusted STARTTLS, terminal attempt 2/recovered lease 1/generation 1→2 và teardown residual 0/0/0. Exact-SHA remote cross-stack CI cũng đã pass hai fresh-volume production activation run; canonical stack đã merge vào `main` tại `059e240b87869bb4b1d87da66b7698c859a34e5e`. Default vẫn false; attachment diff backend đã có typed contract, còn release giữ các blocker client/ops riêng.

Publication job dùng trạng thái `queued|building|succeeded|failed`, phase `queued|preparing|scanning_features|switching|completed|failed`, và progress đo theo feature. `percent=null` cho đến khi biết `totalUnits`; không suy diễn tiến độ từ phase. Failure response chỉ có stable code, thông báo an toàn, correlation `requestId` và `retryable`, không trả stack/raw error. Hai read API có cursor/ETag/304 và chỉ dành cho admin content roles:

| Method | Path                                              | Mô tả                                                  |
| ------ | ------------------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/v1/admin/publication-jobs/{jobId}`          | Job detail đã redacted; `If-None-Match` có thể trả 304 |
| GET    | `/api/v1/admin/layers/{layerId}/publication-jobs` | Cursor page tối đa 100; filter `status`, `revisionId`  |

Publication history/detail của synchronous snapshot chỉ báo `progress=100` cho snapshot `published` đã commit. Nếu gặp row tương thích tương lai không có durable measured progress thì `progress=null`; không suy diễn 50% hoặc 100% từ tên status. Publish đồng bộ thất bại trả Problem Details cùng `requestId` và không tạo success snapshot/pointer/audit.

Public pointer chỉ đổi sau build + validate thành công. Public cache/catalog được revalidate sau commit bằng public ETag/generation mới; frontend không dùng `activePointerEtag` để cache public response.

Ngay trước khi đổi status/snapshot/pointer, publish phải lock layer và active publication pointer rồi tìm **published ancestor gần nhất** bằng chuỗi `supersedesRevisionId`. Active pointer phải trỏ đúng ancestor đó; với publication đầu tiên, cả active pointer và published ancestor đều phải vắng. Nếu không khớp, trả `409 PUBLICATION_BASE_STALE` với `details.activeRevisionId` và `details.baseRevisionId` (nullable), giữ revision ở `approved` và không tạo snapshot, không đổi pointer/status, không ghi workflow/audit success. Rollback hoặc publication khác xảy ra sau khi revision được tạo vì thế không thể bị một candidate stale ghi đè.

### 8.5 Rollback

`POST /api/v1/admin/layers/{layerId}:rollback`

```json
{
  "targetSnapshotId": "0192a810-1902-7891-8a56-61534d66dc92",
  "reason": "Phát hiện sai lệch dữ liệu sau xuất bản.",
  "clientIntent": "desktop"
}
```

Rollback bắt buộc `If-Match: <activePointerEtag>`, `Idempotency-Key`, CSRF, reason và `clientIntent="desktop"`; thiếu hoặc gửi intent khác trả `400 BAD_REQUEST` trước mọi domain mutation. Target phải là snapshot `published` đã từng active (`activatedAt != null`), không phải snapshot hiện hành. Publisher hoặc System Admin đã từng `edit|review` revision đích bị `403 SEPARATION_OF_DUTIES`, kể cả sau khi đổi role.

Rollback tạo publication event mới, đổi pointer atomically, tăng generation, ghi bounded audit và trả publication-pointer ETag mới; không thay đổi/xóa snapshot lịch sử. Stale pointer trả `412 ETAG_MISMATCH` và không tạo snapshot/audit/receipt thành công. Sau commit, admin refetch publication history bằng history ETag và public client revalidate catalog/data bằng public ETag/generation, không dùng lẫn hai ETag domain.

### 8.6 Bounded revision history và feature-level diff

`GET /api/v1/admin/revisions/{revisionId}/diff` nhận `compareTo=parent|active`, `limit=1..25` (mặc định 25) và opaque cursor. Response gồm aggregate summary và `entries[]` theo feature ID ổn định:

- `changeType=added|removed|modified`;
- trước/sau geometry kind, circle `radiusM`, bounds và preview;
- preview có `previewMode=exact` khi geometry tối đa 500 vertex, ngược lại chỉ là `bbox`; bbox không được trình bày như geometry exact;
- trước/sau property public, non-sensitive cùng `changedKeys`; thay đổi chỉ thuộc private/sensitive được biểu diễn bằng `redactedChange=true`, không trả raw value;
- attachment summary luôn trả `{ available:true, featuresModified, added, removed, reordered, redactedChangeCount }`; `added|removed|reordered` chỉ đếm projection của field `image|attachment` có `public=true && sensitive=false`;
- mỗi entry trả attachment `{ available:true, changed, added[], removed[], reordered[], redactedChange }`. Descriptor public chỉ gồm `id`, `fieldKey`, `displayOrder`, `fileName`, `contentType`, `sizeBytes`, `status`; reorder trả order trước/sau. Object/quarantine key, checksum, owner và metadata private không bao giờ xuất hiện;
- association thuộc field private/sensitive được tính vào `redactedChangeCount` và `redactedChange=true` nhưng không trả descriptor. Thay đổi visibility của field được phản ánh như thay đổi public projection;
- cursor keyset ổn định theo feature ID, tối đa 25 entry/page.

Synchronous diff bị giới hạn tối đa 25.000 feature mỗi phía và 2.000.000 vertex tổng. Vượt limit trả `422 DIFF_TOO_LARGE` cùng limit/count, không chạy query không giới hạn và không tự chuyển sang job giả.

Attachment diff đọc trực tiếp canonical `feature_version_attachments` của hai feature version trong cùng transaction `REPEATABLE READ`; không suy diễn từ JSON properties. So sánh association ổn định theo `(featureId, attachmentId, fieldKey)` và phát hiện add/remove/display-order cùng thay đổi public visibility. Query aggregate là set-based và query entry tải attachment cho cả page một lần, không N+1.

## 9. Public catalog và dữ liệu bản đồ

### 9.1 Route summary

| Method | Route                                               | Mô tả                                 |
| ------ | --------------------------------------------------- | ------------------------------------- |
| GET    | `/public/layers`                                    | Catalog lớp đã publish                |
| GET    | `/public/layers/{slug}`                             | Metadata/schema public/style          |
| GET    | `/public/layers/{slug}/features`                    | GeoJSON theo bbox/filter              |
| GET    | `/public/layers/{slug}/features/{featureId}`        | Feature detail                        |
| GET    | `/public/tiles/{slug}/{generation}/{z}/{x}/{y}.pbf` | MVT snapshot generation bất biến      |
| GET    | `/public/search`                                    | Search kết hợp internal + Geo Service |
| GET    | `/public/places/{placeId}`                          | Chi tiết external place đã normalize  |
| GET    | `/public/attachments/{attachmentId}`                | Attachment public                     |

Public API là **supported-client-only** cho frontend DanangMap trong MVP: compatibility, quota và tài liệu chỉ cam kết cho client này. Endpoint vẫn có thể được gọi ngoài browser; CORS/origin allowlist không phải access guarantee hay cơ chế auth. Rate limit, abuse protection và cache áp dụng theo endpoint.

### 9.2 Catalog

`GET /api/v1/public/layers`

```json
{
  "data": [
    {
      "id": "0192a75a-61da-7cc2-9708-8ac54271db52",
      "slug": "administrative-offices",
      "group": {
        "id": "0192a749-4f90-7d74-b2bf-96aa8c28ce41",
        "slug": "government",
        "title": "Cơ quan hành chính",
        "displayOrder": 10
      },
      "displayOrder": 20,
      "title": "Trụ sở hành chính",
      "description": "Vị trí các trụ sở hành chính.",
      "geometryMode": "mixed",
      "allowedGeometryKinds": ["point", "polygon"],
      "snapshotId": "0192a810-1902-7891-8a56-61534d66dc92",
      "revisionId": "0192a75a-ab97-7521-a940-42146868b385",
      "generation": 12,
      "featureCount": 248,
      "bounds": [108.01, 15.87, 108.45, 16.24],
      "sourceKind": "mvt",
      "geoJsonUrl": "/api/v1/public/layers/administrative-offices/features",
      "tileUrlTemplate": "/api/v1/public/tiles/administrative-offices/12/{z}/{x}/{y}.pbf",
      "sourceLayer": "features",
      "minZoom": 8,
      "maxZoom": 18,
      "cluster": true,
      "style": {},
      "popupConfig": {
        "titleField": "name",
        "fieldKeys": ["name", "address"],
        "showCoordinates": false
      },
      "filterCapabilities": {
        "fieldKeys": ["status"],
        "maxFilters": 10
      },
      "searchCapabilities": {
        "enabled": true,
        "fieldKeys": ["name", "address"]
      },
      "updatedAt": "2026-08-20T18:30:00.000Z"
    }
  ]
}
```

Layer detail thêm `fields` gồm field `public=true`, `sensitive=false`: scalar type theo canonical allowlist và `image|attachment` theo association serializer. `image|attachment` chỉ xuất hiện trong schema/detail; không được dùng làm popup scalar, filter, search, GeoJSON hoặc MVT property. Raw object key/URL trong `properties` không bao giờ là public data. Catalog sắp xếp theo group/layer `displayOrder`; layer ungrouped có `group=null`. `sourceKind` là `geojson|mvt|hybrid`; `hybrid` cho phép frontend chọn theo zoom/bbox theo policy catalog. URL là relative supported-client URL, không phải public-access guarantee. Response có ETag theo catalog generation và `Cache-Control` phù hợp.

### 9.3 GeoJSON

`GET /api/v1/public/layers/{slug}/features?bbox=108.0,15.8,108.5,16.3&limit=1000&filter=status:eq:active`

```json
{
  "type": "FeatureCollection",
  "features": [],
  "meta": {
    "layerSlug": "administrative-offices",
    "generation": 12,
    "returned": 0,
    "truncated": false,
    "nextCursor": null
  }
}
```

- Tối đa 5.000 feature hoặc 10 MiB trước nén.
- Query quá rộng trả 400 `QUERY_TOO_BROAD` cùng đề nghị bbox nhỏ hơn/dùng MVT.
- Properties private/sensitive/image/attachment và type chưa được scalar allowlist bị loại bằng cùng policy ở builder/checksum và serializer như defense-in-depth; image/attachment chỉ được trả qua `attachments[]` ở feature detail.

### 9.4 Feature detail

`GET /api/v1/public/layers/{slug}/features/{featureId}`

```json
{
  "data": {
    "type": "Feature",
    "id": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
    "geometry": { "type": "Point", "coordinates": [108.2208, 16.0678] },
    "properties": { "name": "Trụ sở mẫu", "address": "Đà Nẵng" },
    "attachments": [
      {
        "id": "0192a8ff-4969-7561-9b3f-9b987e6e2c10",
        "fieldKey": "images",
        "displayOrder": 0,
        "fileName": "tru-so.jpg",
        "contentType": "image/jpeg",
        "sizeBytes": 483920,
        "status": "clean",
        "url": "/api/v1/public/attachments/0192a8ff-4969-7561-9b3f-9b987e6e2c10"
      }
    ],
    "meta": {
      "layerSlug": "administrative-offices",
      "snapshotId": "0192a810-1902-7891-8a56-61534d66dc92",
      "generation": 12,
      "geometryKind": "point",
      "radiusM": null
    }
  }
}
```

Response có ETag từ `(snapshotId, featureVersionId)`; `If-None-Match` khớp trả 304 không body. Feature không thuộc active snapshot trả 404. `properties` chỉ chứa canonical scalar values; `attachments` là projection association riêng và chỉ chứa object `clean` thuộc field public/non-sensitive của active snapshot. Mảng rỗng tại endpoint này có nghĩa feature hiện không có attachment công khai hợp lệ.

### 9.5 MVT

`GET /api/v1/public/tiles/{slug}/{generation}/{z}/{x}/{y}.pbf`

- Source layer name cố định: `features`.
- `generation` định danh đúng publication snapshot đã từng publish và không đổi theo active pointer. Generation không tồn tại/không thuộc layer trả 404.
- Cache key bao gồm layer/generation/z/x/y/style-schema version; header dùng `Cache-Control: public, max-age=31536000, immutable`. ETag công khai dùng immutable `(snapshotId,generation,z,x,y)`, không nhúng internal checksum có thể phụ thuộc field private.
- Tile rỗng luôn trả HTTP 200 với payload MVT rỗng hợp lệ, đúng `Content-Type`; không trả 204/JSON.
- Catalog active là nơi client nhận generation mới. Rollback tạo generation/publication event mới thay vì tái sử dụng cache identity cũ.

## 10. Combined public search

### 10.1 Contract

`GET /api/v1/public/search`

Query:

| Tên        | Kiểu      | Bắt buộc | Quy định                                     |
| ---------- | --------- | -------: | -------------------------------------------- |
| `q`        | string    |        ✓ | 2–200 ký tự                                  |
| `sources`  | csv       |          | `internal,place`; mặc định cả hai            |
| `layerIds` | csv UUID  |          | tối đa 20, chỉ internal                      |
| `bbox`     | bbox      |          | bias/filter internal theo viewport           |
| `center`   | `lat,lng` |          | bias external; lưu ý upstream dùng `lat,lng` |
| `radiusM`  | integer   |          | 1–50.000; cần center                         |
| `limit`    | integer   |          | mặc định 10, tối đa 30 tổng                  |
| `cursor`   | string    |          | chỉ cho trang tiếp theo; opaque              |

Kết quả normalized:

Với internal result, `position` được tính xác định: Point dùng tọa độ gốc, MultiPoint dùng point đại diện đã khóa trong search index, line dùng midpoint phù hợp, Polygon/MultiPolygon dùng PostGIS `ST_PointOnSurface` để điểm focus nằm trên bề mặt. Đây là search projection, không thay canonical geometry.

```json
{
  "data": [
    {
      "id": "feature:0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
      "source": "internal",
      "kind": "feature",
      "title": "Trụ sở mẫu",
      "subtitle": "Đà Nẵng",
      "position": { "longitude": 108.2208, "latitude": 16.0678 },
      "bbox": null,
      "layer": {
        "id": "0192a75a-61da-7cc2-9708-8ac54271db52",
        "slug": "administrative-offices",
        "title": "Trụ sở hành chính"
      },
      "featureId": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
      "providerPlaceId": null,
      "score": 0.91,
      "highlights": ["Trụ sở"]
    },
    {
      "id": "place:provider-place-id",
      "source": "geo_service",
      "kind": "place",
      "title": "Địa điểm mẫu",
      "subtitle": "Đà Nẵng",
      "position": { "longitude": 108.21, "latitude": 16.06 },
      "bbox": null,
      "layer": null,
      "featureId": null,
      "providerPlaceId": "provider-place-id",
      "score": 0.84,
      "highlights": ["Địa điểm"]
    }
  ],
  "meta": {
    "partial": false,
    "sources": {
      "internal": { "status": "ok", "count": 1 },
      "geoService": { "status": "ok", "count": 1 }
    },
    "warnings": [],
    "nextCursor": null
  }
}
```

Nếu Geo Service timeout/breaker/schema invalid:

```json
{
  "data": [],
  "meta": {
    "partial": true,
    "sources": {
      "internal": { "status": "ok", "count": 0 },
      "geoService": { "status": "unavailable", "count": 0 }
    },
    "warnings": [
      {
        "code": "GEO_SERVICE_UNAVAILABLE",
        "message": "Kết quả địa điểm bên ngoài tạm thời chưa khả dụng."
      }
    ],
    "nextCursor": null
  }
}
```

Đây vẫn là HTTP 200 khi internal search thành công. Không trả upstream raw response/error/URL.

### 10.2 Place details

`GET /api/v1/public/places/{placeId}?fields=name,address,position,phone`

```json
{
  "data": {
    "id": "provider-place-id",
    "name": "Địa điểm mẫu",
    "address": "Đà Nẵng",
    "position": { "longitude": 108.21, "latitude": 16.06 },
    "phone": null,
    "website": null,
    "source": "geo_service"
  }
}
```

`fields` được map sang allowlist upstream. Raw provider payload không lộ ra client.

### 10.3 Anti-corruption adapter

Backend interface nội bộ, không phải public HTTP contract:

```ts
interface GeoServicePort {
  autocomplete(input: string, bias?: GeoBias): Promise<ExternalPlaceCandidate[]>;
  textSearch(query: string, bias?: GeoBias): Promise<ExternalPlaceCandidate[]>;
  placeDetails(placeId: string, fields?: string[]): Promise<ExternalPlaceDetails>;
  geocode(input: GeocodeInput): Promise<GeocodeResult[]>;
  nearbySearch(input: NearbySearchInput): Promise<ExternalPlaceCandidate[]>;
  findPlace(input: FindPlaceInput): Promise<ExternalPlaceCandidate[]>;
  directions(input: DirectionsInput): Promise<DirectionsResult>;
}
```

MVP public API chỉ gọi ba method đầu. Geocode/nearby/find-place/directions được giữ ở adapter cho phase sau và **không** được proxy generic. Mỗi method có runtime schema/versioned fixture. Environment:

- `GEO_SERVICE_BASE_URL`;
- `GEO_SERVICE_CONNECT_TIMEOUT_MS` mặc định 2000;
- `GEO_SERVICE_TOTAL_TIMEOUT_MS` mặc định 5000;
- breaker/retry config có clamp;
- auth header/secret chỉ bổ sung qua secret store nếu chủ dịch vụ công bố contract; OpenAPI hiện không khai báo security nên không giả định credential.

## 11. Audit và lịch sử

| Method | Route                                           | Role         | Mô tả                           |
| ------ | ----------------------------------------------- | ------------ | ------------------------------- |
| GET    | `/admin/audit-events`                           | System Admin | Toàn hệ thống                   |
| GET    | `/admin/layers/{layerId}/audit-events`          | mọi admin    | Lịch sử layer theo phạm vi role |
| GET    | `/admin/revisions/{revisionId}/workflow-events` | mọi admin    | Lịch sử workflow                |

Filter audit: `actorId`, `action`, `resourceType`, `resourceId`, `from`, `to`, cursor. Response không trả secret/raw file cell. Audit append-only; không có DELETE/PATCH route.

`GET /admin/audit-events` chỉ System Admin được gọi. Editor/Reviewer/Publisher chỉ đọc `/admin/layers/{layerId}/audit-events` và `/admin/revisions/{revisionId}/workflow-events`; scope này là content history theo contract, không tạo per-layer RBAC mới. Metadata đi qua action/resource allow-list theo role; password, token, secret, cookie, TOTP, recovery code, encrypted payload, private property value và object key không bao giờ được serialize. Cursor dùng cặp `(occurredAt,id)` để ổn định khi nhiều event trùng timestamp.

Audit và workflow history là immutable read model. Mutation create/update/delete feature và import apply đều ghi participation `edit`; review/publish ghi participation tương ứng. Actor từng edit hoặc review không được publish/rollback revision đó sau khi đổi role. System Admin kế thừa mọi capability nhưng không bypass participant history. Deny/replay/stale path không được tạo success audit event thứ hai.

Event có cardinality lớn chỉ lưu count và digest canonical SHA-256; không lưu raw ID arrays, feature/property values hoặc full catalog snapshots. Catalog update/reorder/archive và revision config replacement ghi `beforeDigest`/`afterDigest`; idempotent replay không tạo audit event thứ hai. Digest phục vụ integrity/reconciliation, không phải cơ chế khôi phục dữ liệu.

Ví dụ event:

```json
{
  "id": "0192a89a-6d66-740a-a146-0080835a742a",
  "action": "revision.approved",
  "actor": {
    "id": "0192a88b-f130-708e-9b42-84460eb4fd8f",
    "displayName": "Kiểm duyệt viên 01",
    "role": "reviewer"
  },
  "resource": {
    "type": "layer_revision",
    "id": "0192a75a-ab97-7521-a940-42146868b385"
  },
  "requestId": "0192a6bd-1bde-7ae5-b003-0652104ddf56",
  "occurredAt": "2026-08-20T18:30:00.000Z"
}
```

## 12. Health và readiness

| Method | Route           | Auth             | Hành vi                                                                                      |
| ------ | --------------- | ---------------- | -------------------------------------------------------------------------------------------- |
| GET    | `/health/live`  | ingress/internal | Process event loop sống; không gọi dependency                                                |
| GET    | `/health/ready` | ingress/internal | Postgres, Redis, migration version, MinIO và durable publication worker heartbeat khi cờ bật |

Response ready:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "checks": {
    "postgres": "up",
    "redis": "up",
    "migrations": "current",
    "minio": "up",
    "geoService": "degraded",
    "mail": "up",
    "publication": "disabled"
  }
}
```

`publication="disabled"` khi feature flag tắt; khi bật thử nghiệm, heartbeat mới và không có durable dependency error trả `up`, còn stale/error trả `degraded`. Geo Service hoặc publication degraded không đổi HTTP core readiness trong checkpoint fail-closed hiện tại; deploy gate đọc từng check. Production có thể giới hạn body health chi tiết theo network policy.

## 13. Rate limit và cache baseline

| Endpoint group        | Baseline                                                                 |
| --------------------- | ------------------------------------------------------------------------ |
| Login/password/MFA    | theo IP + account hash, burst thấp, lockout tăng dần                     |
| Admin mutation        | 120 request/phút/user; batch sync được ưu tiên thay mutation nhỏ dày     |
| Public catalog/detail | 600 request/phút/IP, CDN/cache                                           |
| Public search         | 60 request/phút/IP, debounce client ≥250 ms, cache normalized query ngắn |
| Tiles                 | CDN/reverse proxy; chống stampede theo key                               |
| Upload/import         | concurrency theo user và queue; tối đa 25 MiB/file                       |

Con số là baseline cấu hình, phải load-test trước production. 429 luôn có `Retry-After`.

## 14. Contract/acceptance matrix

| Contract          | Test bắt buộc                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cookie session    | Không có token trong JSON/localStorage; cookie đúng flags; revoke-all gồm caller, xóa cookie và retry tuần tự bằng cookie cũ trả 401                                                                                                                                                                                                                                                                                                           |
| MFA               | Không vào `/admin/*` bằng pre-auth; TOTP/recovery replay bị chặn                                                                                                                                                                                                                                                                                                                                                                               |
| Account lifecycle | Invite inspect/accept/expiry/replay; `mustChangePassword` chặn route domain; password change rotate current/revoke others; reset request generic 202 và token body-only; confirm/revoke-all concurrency + old-cookie 401; recovery-code regenerate; admin MFA reset/re-enroll; user-import inspect/validate/apply/report                                                                                                                       |
| RBAC              | Mỗi admin route có allow test và deny test cho ba role còn lại                                                                                                                                                                                                                                                                                                                                                                                 |
| Separation        | Create/update/delete/import ghi edit participation; actor đổi role vẫn không self-review/publish/rollback revision đã tham gia; System Admin config/upload được nhưng không bypass participant history                                                                                                                                                                                                                                         |
| ETag              | Runtime + OpenAPI có ETag cho mọi versioned lifecycle response; layer-list ETag đổi khi latest revision đổi; history resource, active publication pointer và public cache là ba domain riêng; mutation thiếu `If-Match` → 428, stale → 412; rollback success trả pointer ETag mới rồi public revalidate bằng public ETag/generation                                                                                                            |
| Idempotency       | Retry cùng key/payload cùng response; khác payload → 409                                                                                                                                                                                                                                                                                                                                                                                       |
| Dexie batch       | UUID mapping ổn định, partial conflict đúng mutation, cursor expiry có recovery URL                                                                                                                                                                                                                                                                                                                                                            |
| Dexie recovery    | `origin=recovery` được audit; conflict explicit; logout delete; expiry lock; không server lease; sensitive/offlineCache policy                                                                                                                                                                                                                                                                                                                 |
| Geometry          | Cả 6 GeoJSON type + Point-only circle/radiusM; cấm GeometryCollection/Z/M/invalid polygon; 100.000 vertex và 64 KiB property boundaries                                                                                                                                                                                                                                                                                                        |
| Layer config      | Group→layer lock order và archive/create/move/unarchive race không để dangling archived-group reference; value-aware bounded impact + atomic full config replacement; strict ETag/idempotency/audit digest; published immutability; draft vắng mặt public                                                                                                                                                                                      |
| Import            | MIME spoof, exact 25 MiB, `.json` sniff, 100.000 record, 2.000.000 vertex, 250 MiB expanded, XLSX sheet/column, 20.000 DB issue, 3 mode, skip invalid, retry/cancel                                                                                                                                                                                                                                                                            |
| Workflow          | DB chỉ cho một open chain qua `draft`, `in_review`, `approved`, `publishing`; cross-path successor race chỉ một winner; chín history endpoint đúng OpenAPI; durable async path default-off có queued/building/measured progress, lease recovery và final atomic pointer switch; flag false giữ synchronous terminal path; stale base/build failure không đổi pointer; participant history deny; rollback target từng active và tăng generation |
| Lifecycle guards  | Table-driven deny cho Reviewer/Publisher, System Admin allow, CSRF 403, thiếu If-Match 428, idempotency mismatch 409; real Postgres race fixtures và OpenAPI ETag-header assertions xanh                                                                                                                                                                                                                                                       |
| Audit/history     | Global System Admin-only, layer content-role scope, immutable cursor page, action metadata allow-list; high-cardinality metadata chỉ count + canonical SHA-256 digest với before/after digest; replay/stale không tạo success event thứ hai; không raw IDs/value/private data                                                                                                                                                                  |
| Privacy           | Field private vắng mặt trong catalog/detail/search/GeoJSON/MVT/attachment                                                                                                                                                                                                                                                                                                                                                                      |
| Combined search   | Normalize fixtures, timeout/retry/breaker, partial 200, không leak raw provider                                                                                                                                                                                                                                                                                                                                                                |
| Attachment        | Upload/finalize, bind/unbind/reorder tạo feature version mới, orphan cleanup không xóa object snapshot tham chiếu; revision diff trả typed public association add/remove/reorder và marker redacted cho thay đổi private/sensitive                                                                                                                                                                                                             |
| MVT               | Full catalog source descriptor, source layer `features`, generation URL immutable, unknown generation 404, empty tile HTTP 200 valid MVT, bbox/query SQL có spatial index                                                                                                                                                                                                                                                                      |
| Feature/search    | Detail ETag/304; polygon/multipolygon search position dùng `ST_PointOnSurface`                                                                                                                                                                                                                                                                                                                                                                 |
| Error             | Mọi lỗi theo envelope và có request ID; không stack trace/secret                                                                                                                                                                                                                                                                                                                                                                               |

## 15. Versioning và tương thích

- Breaking HTTP change tạo `/api/v2`; field optional có thể thêm trong v1.
- Enum mới chỉ thêm khi frontend typed client có fallback.
- OpenAPI được generate trong CI, diff breaking là required check.
- Frontend SDK generate từ artifact OpenAPI đã pin commit/version; backend deploy trước frontend nếu additive.
- Geo Service fixture/schema có version riêng trong adapter. Upstream generic object thay đổi không được lan thẳng vào public DTO.

## 16. Endpoint dành cho phase sau

Các endpoint sau chưa thuộc MVP và không được expose placeholder trả dữ liệu giả:

- `/api/v1/public/geocode`;
- `/api/v1/public/reverse-geocode`;
- `/api/v1/public/nearby-search`;
- `/api/v1/public/directions`.

Khi kích hoạt, chúng PHẢI dùng `GeoServicePort`, DTO DanangMap đã normalize, cùng timeout/schema/circuit-breaker policy; không dùng Mapbox Geocoding/Directions và không proxy raw response.

## 17. Rủi ro vận hành đã ghi nhận

Không có backup/restore trong phạm vi hiện tại. API không tuyên bố durability vượt quá persistent volume. Import report, snapshot và attachment có thể không phục hồi nếu mất PostGIS/MinIO. Đây là accepted risk cần được sign-off lại trước production go-live; không thay đổi hợp đồng atomic publish nhưng ảnh hưởng khả năng disaster recovery.
