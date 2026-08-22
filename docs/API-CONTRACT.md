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

### 1.3 Cookie admin

- `__Host-danangmap_session`: opaque random value, HttpOnly, Secure, SameSite=Lax, Path=/.
- `danangmap_csrf`: token CSRF không HttpOnly để frontend đọc và echo qua `X-CSRF-Token`; không phải credential.
- Login trước MFA chỉ tạo pre-auth cookie hạn ngắn, không có quyền admin.
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

### 1.7 Mã lỗi chuẩn

`AUTH_INVALID_CREDENTIALS`, `AUTH_MFA_REQUIRED`, `AUTH_MFA_INVALID`, `AUTH_MFA_ENROLLMENT_REQUIRED`, `AUTH_MFA_ENROLLMENT_ALREADY_STARTED`, `AUTH_MFA_ENROLLMENT_STALE`, `AUTH_MFA_ALREADY_ENROLLED`, `AUTH_MFA_RATE_LIMITED`, `AUTH_SESSION_EXPIRED`, `INVITE_INVALID_OR_EXPIRED`, `PASSWORD_CHANGE_REQUIRED`, `PASSWORD_RESET_INVALID_OR_EXPIRED`, `CSRF_INVALID`, `ROLE_FORBIDDEN`, `SEPARATION_OF_DUTIES`, `VALIDATION_FAILED`, `GEOMETRY_INVALID`, `GEOMETRY_TYPE_NOT_ALLOWED`, `RESOURCE_LIMIT_EXCEEDED`, `SCHEMA_VIOLATION`, `ETAG_REQUIRED`, `ETAG_MISMATCH`, `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_KEY_REUSED`, `DRAFT_ALREADY_EXISTS`, `REVISION_NOT_EDITABLE`, `WORKFLOW_TRANSITION_INVALID`, `SYNC_CONFLICT`, `SYNC_CURSOR_EXPIRED`, `IMPORT_TOO_LARGE`, `IMPORT_FORMAT_UNSUPPORTED`, `IMPORT_NOT_READY`, `IMPORT_HAS_ERRORS`, `ATTACHMENT_NOT_READY`, `PUBLICATION_FAILED`, `FILTER_NOT_ALLOWED`, `QUERY_TOO_BROAD`, `GEO_SERVICE_INVALID_RESPONSE`, `RATE_LIMITED`.

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

| Method    | Route                                  | Auth/role                          | Mô tả                                                               |
| --------- | -------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| GET       | `/auth/csrf`                           | public/pre-auth/auth               | Cấp hoặc lấy token CSRF hiện tại; không rotate trong cùng session   |
| POST      | `/auth/login`                          | public + CSRF                      | Xác minh username/email + password                                  |
| POST      | `/auth/mfa/verify`                     | pre-auth + CSRF                    | Xác minh TOTP/recovery code, tạo session                            |
| POST      | `/auth/mfa/enroll`                     | pre-auth + CSRF                    | Bắt đầu enroll TOTP; URI chỉ trả một lần cho pre-auth đó            |
| POST      | `/auth/mfa/enroll/confirm`             | pre-auth + CSRF                    | Xác nhận TOTP lần đầu, trả recovery codes một lần                   |
| POST      | `/auth/mfa/recovery-codes:regenerate`  | authenticated                      | Xác minh password + MFA rồi thay toàn bộ recovery codes             |
| GET       | `/auth/me`                             | authenticated                      | Principal hiện tại                                                  |
| POST      | `/auth/logout`                         | authenticated                      | Thu hồi phiên hiện tại                                              |
| POST      | `/auth/sessions:revoke-all`            | authenticated + CSRF + idempotency | Thu hồi mọi session, gồm session đang gọi                           |
| POST      | `/auth/password/change`                | authenticated + CSRF + idempotency | Đổi password, rotate session hiện tại và revoke các session còn lại |
| POST      | `/auth/password/reset:request`         | public + idempotency               | Luôn trả generic `202`, không tiết lộ account tồn tại               |
| POST      | `/auth/password/reset:confirm`         | public + CSRF                      | Đặt password bằng token một lần chỉ nhận trong body                 |
| POST      | `/auth/invites:inspect`                | public                             | Inspect invite an toàn, không tiêu thụ token                        |
| POST      | `/auth/invites:accept`                 | public                             | Đặt password, tiêu thụ invite và chuyển sang MFA enroll             |
| GET/POST  | `/admin/users`                         | System Admin                       | Danh sách/tạo user                                                  |
| GET/PATCH | `/admin/users/{userId}`                | System Admin                       | Xem/cập nhật/khóa user                                              |
| POST      | `/admin/invites`                       | System Admin                       | Tạo invite                                                          |
| POST      | `/admin/invites/{inviteId}:revoke`     | System Admin                       | Thu hồi invite                                                      |
| POST      | `/admin/users/{userId}/mfa:reset`      | System Admin                       | Thu hồi MFA/session và bắt buộc re-enroll                           |
| POST      | `/admin/user-imports`                  | System Admin                       | Upload và inspect danh sách user                                    |
| GET       | `/admin/user-imports/{jobId}`          | System Admin                       | Theo dõi inspect/validate/apply                                     |
| POST      | `/admin/user-imports/{jobId}:validate` | System Admin                       | Dry-run duplicate/validation                                        |
| POST      | `/admin/user-imports/{jobId}:apply`    | System Admin                       | Tạo account invite/inactive idempotent                              |
| GET       | `/admin/user-imports/{jobId}/report`   | System Admin                       | Tải report đã lọc                                                   |

### 3.2 Login và MFA

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

### 3.3 Tạo user

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

`POST /api/v1/admin/users/{userId}/mfa:reset` nhận `{ "reason": "Thiết bị MFA đã mất." }`; reason bắt buộc, response trả `mfaEnrollmentRequired=true` và số session đã revoke, không trả secret/code.

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

Yêu cầu `Idempotency-Key`. Email có và không có account đều trả cùng generic `202 { "status": "accepted" }` trong cùng lớp timing; rate limit áp dụng theo IP + account hash. Retry cùng key/payload không tạo thêm outbox; cùng key khác payload trả `409 IDEMPOTENCY_KEY_REUSED`. Mail adapter gửi token random một lần qua outbox; DB chỉ lưu hash, mặc định hết hạn sau 30 phút và token mới revoke token cũ.

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

| Method | Route                                         | Role      | Mô tả                                                         |
| ------ | --------------------------------------------- | --------- | ------------------------------------------------------------- |
| GET    | `/admin/layer-groups`                         | mọi admin | Liệt kê group theo display order                              |
| POST   | `/admin/layer-groups`                         | Editor    | Tạo group                                                     |
| PATCH  | `/admin/layer-groups/{groupId}`               | Editor    | Sửa metadata/order                                            |
| POST   | `/admin/layer-groups/{groupId}:archive`       | Editor    | Archive group, không xóa layer                                |
| GET    | `/admin/layers`                               | mọi admin | Liệt kê layer                                                 |
| POST   | `/admin/layers`                               | Editor    | Tạo layer + draft đầu tiên                                    |
| GET    | `/admin/layers/{layerId}`                     | mọi admin | Chi tiết layer                                                |
| PATCH  | `/admin/layers/{layerId}`                     | Editor    | Đổi metadata identity chưa versioned                          |
| POST   | `/admin/layers/{layerId}:archive`             | Editor    | Archive mềm                                                   |
| GET    | `/admin/layers/{layerId}/revisions`           | mọi admin | Lịch sử revision                                              |
| POST   | `/admin/layers/{layerId}/drafts`              | Editor    | Tạo draft từ snapshot active                                  |
| GET    | `/admin/revisions/{revisionId}`               | mọi admin | Chi tiết revision                                             |
| PATCH  | `/admin/revisions/{revisionId}`               | Editor    | Sửa title/description/geometry mode/style/render/popup config |
| PUT    | `/admin/revisions/{revisionId}/fields`        | Editor    | Thay danh sách schema fields có version check                 |
| POST   | `/admin/revisions/{revisionId}/schema:impact` | Editor    | Preview ảnh hưởng schema                                      |
| GET    | `/admin/revisions/{revisionId}/workspace`     | mọi admin | Metadata sync workspace                                       |
| GET    | `/admin/revisions/{revisionId}/features`      | mọi admin | Feature theo bbox/cursor                                      |

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

Layer group là cấu trúc trình bày, không phải permission boundary. Group DTO gồm `id`, `slug`, `title`, `description`, `displayOrder`, `archivedAt`. `groupId` có thể null. Archive group yêu cầu body `{ "orphanLayerPolicy": "ungroup" }`, atomically đặt `groupId=null` cho layer thuộc group và không archive/xóa layer.

`popupConfig` được version hóa cùng revision. Chỉ chấp nhận key allowlist như `titleField`, `subtitleField`, `fieldKeys`, `showCoordinates`; mọi field tham chiếu phải tồn tại. Public projection tự loại field private/sensitive khỏi popup kể cả config cũ còn tham chiếu.

`renderConfig.sourcePolicy`: `auto|geojson|mvt|hybrid`. Publication builder có thể hạ `auto` thành source descriptor cụ thể dựa trên benchmark/feature count nhưng không được đổi canonical data; min/max zoom và cluster được validate theo geometry/style.

### 4.3 Workspace

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

### 4.4 Liệt kê feature admin

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
  "clientId": "browser-0192a793",
  "origin": "recovery",
  "baseCursor": "cur_01J5ABC",
  "mutations": [
    {
      "clientMutationId": "0192a794-1f84-79a5-95e2-60a888c591cd",
      "operation": "create",
      "clientFeatureId": "local-0192a794",
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
      "featureId": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
      "baseVersionId": "0192a6c1-5bb4-7bc0-8376-c8d69bcd2f37",
      "patch": {
        "properties": { "phone": "0236 000 0000" }
      }
    }
  ]
}
```

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
        "canonicalFeatureId": "0192a79a-74eb-7221-aa2b-3dc4ae326ec9",
        "versionId": "0192a79a-af0d-78e1-883a-c555f1a16107"
      },
      {
        "clientMutationId": "0192a794-5d70-71c1-a28f-e034fd2a6c8b",
        "status": "conflict",
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

Một mutation được reject/conflict không làm rollback mutation độc lập khác; response luôn có result cho từng mutation. Retry cùng `clientMutationId` và payload trả lại kết quả cũ; cùng ID nhưng payload khác trả 409 `IDEMPOTENCY_KEY_REUSED`.

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

Nếu cursor quá cũ, trả 409 `SYNC_CURSOR_EXPIRED`, `details.workspaceUrl` và ETag hiện tại. Client fetch workspace/full needed viewport, giữ mutation local chưa ack và rebase có kiểm soát.

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

| Method | Route                                                                           | Role       | Mô tả                                                         |
| ------ | ------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| POST   | `/admin/uploads`                                                                | Editor     | Tạo upload intent cho feature attachment                      |
| POST   | `/admin/uploads/{uploadId}:complete`                                            | chủ upload | Xác nhận upload/checksum                                      |
| GET    | `/admin/attachments/{attachmentId}`                                             | admin      | Metadata/status                                               |
| DELETE | `/admin/attachments/{attachmentId}`                                             | chủ/Editor | Xóa object chưa bind                                          |
| POST   | `/admin/revisions/{revisionId}/features/{featureId}/attachments:bind`           | Editor     | Bind attachment vào field versioned                           |
| PATCH  | `/admin/revisions/{revisionId}/features/{featureId}/attachments:reorder`        | Editor     | Đổi display order và tạo feature version mới                  |
| DELETE | `/admin/revisions/{revisionId}/features/{featureId}/attachments/{attachmentId}` | Editor     | Unbind và tạo feature version mới                             |
| GET    | `/public/attachments/{attachmentId}`                                            | public     | Đọc attachment chỉ khi thuộc field public của snapshot active |

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

Response có upload URL MinIO TTL ngắn và required headers; ví dụ tài liệu không ghi URL thật. Complete chỉ thành công khi size/checksum/MIME khớp. Binary không đi qua Dexie lâu dài.

Bind yêu cầu `If-Match` và body:

```json
{
  "fieldKey": "images",
  "attachmentId": "0192a8ff-4969-7561-9b3f-9b987e6e2c10",
  "displayOrder": 10
}
```

Field phải có type `image|attachment`, object phải finalized và policy scan hợp lệ. Bind/unbind/reorder tạo `feature_version_attachments` mới cùng feature version; không sửa association của version cũ. Canonical field value là danh sách attachment ID có thứ tự được materialize từ association, không nhận raw object key/URL từ `properties`. Feature response trả `attachments[]` gồm ID, fieldKey, displayOrder, fileName, contentType, sizeBytes và trạng thái; public projection chỉ trả association thuộc field `public=true` của active snapshot. Attachment orphan chưa từng bind được worker xóa sau retention cấu hình; object từng được snapshot tham chiếu không được hard-delete bởi cleanup.

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

Layer vẫn chỉ có một active draft. Nếu đã tồn tại draft khác, command trả 409 `DRAFT_ALREADY_EXISTS` và không đổi trạng thái revision gốc. Successor draft là resource mới; không chuyển revision submitted trở lại editable.

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

Mặc định `ASYNC_PUBLICATION_ENABLED=false`, publish giữ nguyên đường **đồng bộ** trong một transaction: HTTP request chỉ trả sau khi snapshot, pointer, revision state, participant, workflow event, audit và idempotency receipt đã commit. Trong lúc POST còn chạy, client chỉ hiển thị trạng thái indeterminate; không có publication ID đã commit để polling và không được dựng phần trăm giả. Ở chế độ này `clientIntent` chưa bắt buộc để giữ tương thích contract hiện hữu. Validation cấu hình vẫn từ chối `ASYNC_PUBLICATION_ENABLED=true` khi `NODE_ENV=production` cho đến khi frontend polling và exact full-stack activation được chấp nhận.

Khi bật cờ thử nghiệm, `clientIntent="desktop"` là bắt buộc và được kiểm tra trước transaction. Admission commit atomically receipt, lock/precondition/SoD, revision `publishing`, durable `publication_jobs` row trạng thái `queued`, outbox, workflow event và audit; sau đó trả `202` với job representation, `Location`, `ETag`, `Retry-After` và `Cache-Control: private, no-store`. Cùng idempotency key/body replay đúng response + ETag; key/body khác trả 409. Worker claim lease trong Postgres, đo feature/vertex thật, persist public-only UUID-keyset batches, resume checkpoint, recheck actor/role/SoD/fingerprint/base pointer và chỉ đổi pointer trong final transaction ngắn. Failure ổn định đưa revision về `approved`; Redis loss/lease expiry được reconcile; duplicate delivery hoặc crash sau final commit là no-op. Backend barrier hook chỉ được chấp nhận với `NODE_ENV=test`; filesystem phase/seed controls chỉ được wire trong exact E2E Compose, không phải HTTP contract production. Frontend SHA `6e6fe83f7dbf6d5a01c710bb35e670e08b63e1b8` đã được pin/review; independent backend review và two-run fresh-volume evidence vẫn pending. Production vẫn fail-closed và backend #30 tiếp tục mở.

Publication job dùng trạng thái `queued|building|succeeded|failed`, phase `queued|preparing|scanning_features|switching|completed|failed`, và progress đo theo feature. `percent=null` cho đến khi biết `totalUnits`; không suy diễn tiến độ từ phase. Failure response chỉ có stable code, thông báo an toàn, correlation `requestId` và `retryable`, không trả stack/raw error. Hai read API có cursor/ETag/304 và chỉ dành cho admin content roles:

| Method | Path                                              | Mô tả                                                  |
| ------ | ------------------------------------------------- | ------------------------------------------------------ |
| GET    | `/api/v1/admin/publication-jobs/{jobId}`          | Job detail đã redacted; `If-None-Match` có thể trả 304 |
| GET    | `/api/v1/admin/layers/{layerId}/publication-jobs` | Cursor page tối đa 100; filter `status`, `revisionId`  |

Publication history/detail của synchronous snapshot chỉ báo `progress=100` cho snapshot `published` đã commit. Nếu gặp row tương thích tương lai không có durable measured progress thì `progress=null`; không suy diễn 50% hoặc 100% từ tên status. Publish đồng bộ thất bại trả Problem Details cùng `requestId` và không tạo success snapshot/pointer/audit.

Public pointer chỉ đổi sau build + validate thành công. Public cache/catalog được revalidate sau commit bằng public ETag/generation mới; frontend không dùng `activePointerEtag` để cache public response.

### 8.5 Rollback

`POST /api/v1/admin/layers/{layerId}:rollback`

```json
{
  "targetSnapshotId": "0192a810-1902-7891-8a56-61534d66dc92",
  "reason": "Phát hiện sai lệch dữ liệu sau xuất bản.",
  "clientIntent": "desktop"
}
```

Rollback bắt buộc `If-Match: <activePointerEtag>`, `Idempotency-Key`, CSRF, reason và `clientIntent="desktop"`; thiếu hoặc gửi intent khác trả `400 BAD_REQUEST` trước mọi domain mutation. Target phải là snapshot `published` đã từng active (`activatedAt != null`), không phải snapshot hiện hành. Publisher đã từng `edit|review` revision đích bị `403 SEPARATION_OF_DUTIES`, kể cả sau khi đổi role; System Admin không bypass.

Rollback tạo publication event mới, đổi pointer atomically, tăng generation, ghi bounded audit và trả publication-pointer ETag mới; không thay đổi/xóa snapshot lịch sử. Stale pointer trả `412 ETAG_MISMATCH` và không tạo snapshot/audit/receipt thành công. Sau commit, admin refetch publication history bằng history ETag và public client revalidate catalog/data bằng public ETag/generation, không dùng lẫn hai ETag domain.

### 8.6 Bounded revision history và feature-level diff

`GET /api/v1/admin/revisions/{revisionId}/diff` nhận `compareTo=parent|active`, `limit=1..25` (mặc định 25) và opaque cursor. Response gồm aggregate summary và `entries[]` theo feature ID ổn định:

- `changeType=added|removed|modified`;
- trước/sau geometry kind, circle `radiusM`, bounds và preview;
- preview có `previewMode=exact` khi geometry tối đa 500 vertex, ngược lại chỉ là `bbox`; bbox không được trình bày như geometry exact;
- trước/sau property public, non-sensitive cùng `changedKeys`; thay đổi chỉ thuộc private/sensitive được biểu diễn bằng `redactedChange=true`, không trả raw value;
- cursor keyset ổn định theo feature ID, tối đa 25 entry/page.

Synchronous diff bị giới hạn tối đa 25.000 feature mỗi phía và 2.000.000 vertex tổng. Vượt limit trả `422 DIFF_TOO_LARGE` cùng limit/count, không chạy query không giới hạn và không tự chuyển sang job giả.

Attachment diff chưa khả dụng cho tới khi backend #29 cung cấp canonical `feature_version_attachments`. Cả summary và từng entry trả đúng `{ "available": false, "status": "unavailable", "reasonCode": "ATTACHMENT_CONTRACT_PENDING" }`; mảng rỗng không được dùng để ngụ ý “không thay đổi attachment”. Vì vậy backend #30 và frontend #19 vẫn Open/In Progress.

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

Layer detail thêm `fields` nhưng chỉ gồm field thuộc canonical public allowlist: `public=true`, `sensitive=false` và type scalar an toàn hiện được hỗ trợ. `image|attachment` cùng type mới chưa có serializer an toàn bị loại khỏi schema, popup, filter, search, GeoJSON và MVT cho tới khi backend #29 cung cấp association serializer; raw object key/URL trong `properties` không bao giờ là public data. Catalog sắp xếp theo group/layer `displayOrder`; layer ungrouped có `group=null`. `sourceKind` là `geojson|mvt|hybrid`; `hybrid` cho phép frontend chọn theo zoom/bbox theo policy catalog. URL là relative supported-client URL, không phải public-access guarantee. Response có ETag theo catalog generation và `Cache-Control` phù hợp.

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
- Properties private/sensitive/image/attachment và type chưa được canonical allowlist bị loại bằng cùng policy ở builder/checksum và serializer như defense-in-depth.

### 9.4 Feature detail

`GET /api/v1/public/layers/{slug}/features/{featureId}`

```json
{
  "data": {
    "type": "Feature",
    "id": "0192a6bc-7e70-7ef5-9cc2-5773f77276a9",
    "geometry": { "type": "Point", "coordinates": [108.2208, 16.0678] },
    "properties": { "name": "Trụ sở mẫu", "address": "Đà Nẵng" },
    "attachments": [],
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

Response có ETag từ `(snapshotId, featureVersionId)`; `If-None-Match` khớp trả 304 không body. Feature không thuộc active snapshot trả 404. Checkpoint hiện chỉ serialize canonical scalar properties; `attachments=[]` là marker chưa khả dụng, không phải bằng chứng không có attachment.

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

Audit và workflow history là immutable read model. Mutation create/update/delete feature và import apply đều ghi participation `edit`; review/publish ghi participation tương ứng. Actor từng edit hoặc review không được publish/rollback revision đó sau khi đổi role, và System Admin không có workflow bypass. Deny/replay/stale path không được tạo success audit event thứ hai.

Event có cardinality lớn chỉ lưu count và digest canonical SHA-256; không lưu raw ID arrays, feature/property values hoặc full catalog snapshots. Idempotent replay không tạo audit event thứ hai. Digest phục vụ integrity/reconciliation, không phải cơ chế khôi phục dữ liệu.

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

| Contract          | Test bắt buộc                                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Cookie session    | Không có token trong JSON/localStorage; cookie đúng flags; revoke-all gồm caller, xóa cookie và retry tuần tự bằng cookie cũ trả 401                                                                                                                                                                                     |
| MFA               | Không vào `/admin/*` bằng pre-auth; TOTP/recovery replay bị chặn                                                                                                                                                                                                                                                         |
| Account lifecycle | Invite inspect/accept/expiry/replay; `mustChangePassword` chặn route domain; password change rotate current/revoke others; reset request generic 202 và token body-only; confirm/revoke-all concurrency + old-cookie 401; recovery-code regenerate; admin MFA reset/re-enroll; user-import inspect/validate/apply/report |
| RBAC              | Mỗi admin route có allow test và deny test cho ba role còn lại                                                                                                                                                                                                                                                           |
| Separation        | Create/update/delete/import ghi edit participation; actor đổi role vẫn không self-review/publish/rollback revision đã tham gia; System Admin không config/upload content hoặc bypass                                                                                                                                     |
| ETag              | History resource, active publication pointer và public cache là ba domain riêng; rollback thiếu pointer `If-Match` → 428, stale → 412; success trả pointer ETag mới rồi public revalidate bằng public ETag/generation                                                                                                    |
| Idempotency       | Retry cùng key/payload cùng response; khác payload → 409                                                                                                                                                                                                                                                                 |
| Dexie batch       | UUID mapping ổn định, partial conflict đúng mutation, cursor expiry có recovery URL                                                                                                                                                                                                                                      |
| Dexie recovery    | `origin=recovery` được audit; conflict explicit; logout delete; expiry lock; không server lease; sensitive/offlineCache policy                                                                                                                                                                                           |
| Geometry          | Cả 6 GeoJSON type + Point-only circle/radiusM; cấm GeometryCollection/Z/M/invalid polygon; 100.000 vertex và 64 KiB property boundaries                                                                                                                                                                                  |
| Layer config      | Group CRUD/order/archive-ungroup, popupConfig versioning và private-field stripping                                                                                                                                                                                                                                      |
| Import            | MIME spoof, exact 25 MiB, `.json` sniff, 100.000 record, 2.000.000 vertex, 250 MiB expanded, XLSX sheet/column, 20.000 DB issue, 3 mode, skip invalid, retry/cancel                                                                                                                                                      |
| Workflow          | Chín history endpoint đúng OpenAPI; bounded feature-level cursor diff + circle radius/redaction; publish synchronous indeterminate→terminal, không % giả; build fail không đổi pointer; rollback target từng active và tăng generation                                                                                   |
| Audit/history     | Global System Admin-only, layer content-role scope, immutable cursor page, action metadata allow-list, replay/stale không tạo success event thứ hai                                                                                                                                                                      |
| Privacy           | Field private vắng mặt trong catalog/detail/search/GeoJSON/MVT/attachment                                                                                                                                                                                                                                                |
| Combined search   | Normalize fixtures, timeout/retry/breaker, partial 200, không leak raw provider                                                                                                                                                                                                                                          |
| Attachment        | Upload/finalize, bind/unbind/reorder tạo feature version mới, orphan cleanup không xóa object snapshot tham chiếu; diff trả `ATTACHMENT_CONTRACT_PENDING` cho tới backend #29                                                                                                                                            |
| MVT               | Full catalog source descriptor, source layer `features`, generation URL immutable, unknown generation 404, empty tile HTTP 200 valid MVT, bbox/query SQL có spatial index                                                                                                                                                |
| Feature/search    | Detail ETag/304; polygon/multipolygon search position dùng `ST_PointOnSurface`                                                                                                                                                                                                                                           |
| Error             | Mọi lỗi theo envelope và có request ID; không stack trace/secret                                                                                                                                                                                                                                                         |

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
