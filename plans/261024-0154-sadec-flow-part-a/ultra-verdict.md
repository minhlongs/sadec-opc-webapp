# Ultra verdict — ak:advise --ultra (N=4)

Run metadata: `picked=1/4 margin=low unanimous=no rejected_all=no n_disclosed=4`

The fan-out gate requires five usable candidates. Only four of five in this wave
returned complete advice (one was truncated mid-section). The user chose to
proceed, so the verifier scored four and disclosed N=4 in its receipt rather than
letting the run look like a five-candidate pass.

## Ranking

| Rank | Candidate | Faithfulness | Evidence | Trade-offs | Actionability | Total |
|---|---|---|---|---|---|---|
| 1 | A | 18 | 13 | 18 | 16 | 65 |
| 2 | C | 17 | 14 | 16 | 13 | 60 |
| 3 | B | 17 | 9 | 15 | 17 | 58 |
| 4 | D | 15 | 8 | 13 | 13 | 49 |

Margin is low and no criterion was unanimous: a single default pass would likely
have produced comparable output at a fifth of the cost. The verifier also judged
the selection correct but not durable — a fifth candidate combining A's
trade-off honesty with C's correct auth guidance would likely displace A.

## Hard failures found by the verifier

- **A contradicts verified ground truth.** Its "Không nên làm" list says
  Worker-level Access needs only `ctx.access.getIdentity()` and that adding a JWT
  layer "adds a fatal error". Verified against Cloudflare's static-assets routing
  docs: Workers with Static Assets execute behind an internal router Worker, and
  that router does **not** pass `ctx.access` to the user Worker. The bullet also
  contradicts A's own verdict and its own item 7 (membership by email requires a
  JWT-derived email). Following it would ship a pilot with no login path.
- **B and D assert the repo is empty.** It is not: the repo carries 1,791 tracked
  files, 1,788 of them under `.claude/`. An executor taking that at face value
  could re-scaffold over a tracked tree.

No candidate reversed a binding user decision.

## How the controller resolved these

Candidate A is the winner on ranking, so it is quoted verbatim below. The
controller did **not** hand A's text to an executor unchanged:

1. A's `ctx.access.getIdentity()` bullet is dropped and replaced with the
   verified instruction — the Worker must self-verify the
   `Cf-Access-Jwt-Assertion` header against
   `https://<team-domain>.cloudflareaccess.com/cdn-cgi/access/certs`, checking
   `iss`, `aud`, `exp`, and matching the token `kid` against `public_certs`
   (keys rotate every 6 weeks, old keys stay valid 7 more days).
2. A's "repo đang trống" framing is dropped; the worktree starts from the
   existing tracked tree.
3. A's `npm run build` is `pnpm build`; the repo is pnpm-only, and no workspace
   file exists, so the startup hook's "monorepo" label does not apply.
4. A's invented "14 ảnh" count is not carried into acceptance criteria.

Two claims in A remain unverified by the controller and are carried forward as
open items rather than facts: the D1 100-bound-parameter limit (both limits URLs
returned errors) and the 500MB/DB Free-plan figure.

---

## Winning advice, candidate A, verbatim

> **1. Verdict**
>
> Khả thi và đúng thứ tự: build trước, ship một lát cắt chạy thật, phỏng vấn sau — ba mục đích của bạn đều phục vụ bởi cùng một bản build. Nhưng rủi ro lớn nhất của dự án này không phải thiếu dữ liệu hay thiếu AI key (spec lo được), mà là bất biến tiền/lịch sử/versions trong D1: nhiều invariant đòi hỏi "một hàng thắng" với optimistic concurrency mà D1 không cho miễn phí (`UPDATE 0 rows` không tự lỗi, batch chỉ là transaction SQL chứ không phải row-lock), và spec lại yêu cầu 17 kiểm chứng cho hành vi vốn đòi thiết kế cẩn thận nhất. Thêm hai điểm còn treo thật sự: `ctx.access` **không** tới được Worker của bạn khi Static Assets bật (docs đã xác nhận router Worker không chuyển tiếp) — nên Access Free allowlist chỉ bảo vệ cửa, **không** cho email đăng nhập; và Playwright chưa có browser (Chrome hệ thống có sẵn nên lấp được bằng `channel: chrome`, nhưng đây là việc phải làm sớm). Kết luận: làm, nhưng chốt một "domain function" cho tiền + một biểu hiện quyền duy nhất trước khi chia agent song song, nếu không tích hợp sẽ vỡ.
>
> **2. Nên làm (thứ tự)**
>
> 1. Phase 0 ép cứng trong một ticket: chốt pnpm + Vite + React + TS + Hono + D1 + Zod, ghi `docs/DECISIONS.md` 5 dòng, tạo repo skeleton + `docs/CHECKPOINT.md`. Không viết báo cáo dài thay code.
> 2. Chốt một file hợp đồng dữ liệu trước khi ai viết code: `src/domain/types.ts` (Zod schemas cho money/status/version) + `src/domain/money.ts` (integer VND, basis points, overflow/NaN/negative guard) + `src/domain/economics.ts` (một hàm duy nhất cho cả 3 ca §13, §15 case 14). Ba file này là nguồn chân lý, mọi agent đọc, không ai sửa.
> 3. Migration 001 khởi tạo toàn bộ entity §14 trong một file + seed demo idempotent (`db:seed:demo`).
> 4. Lát cắt chạy Phase 1 (§16) trước: app shell, D1 local, identity demo, 1 workspace, sản phẩm/khách, lưu báo giá — chứng minh persistence qua restart.
> 5. Song song hóa từ Phase 2, không từ Phase 1: Agent A (ops), Agent B (founder), Agent C (identity/Access/deploy) — tất cả đọc chung file hợp đồng, không ai sửa migration cũ.
> 6. Quyền: một điểm duy nhất `requireRole()` trong Worker.
> 7. Preview URL đúng nghĩa: đăng nhập bằng allowlist email founder, kèm server-side membership map — email → role, bootstrap founder qua lệnh admin có guard.
> 8. Ba môi trường dữ liệu tách bạch bằng 3 binding khác nhau.
> 9. Kiểm chứng chạy trước khi báo PASS, không đánh dấu §15 case nào mà chưa chạy.
> 10. `docs/RELEASE.md` + click-through acceptance doc (mới, ngoài §17).
>
> **3. Không nên làm**
>
> - Không lấy `ctx.access` làm nguồn identity trên Static Assets. Rào đúng: Access bảo vệ cửa + server-side membership theo email.
> - Không dùng `batch()` như thể nó chặn overpay. Hai receipt khác nhau xác nhận đồng thời là hai request riêng.
> - Không để `UPDATE 0 rows` trôi thành lỗi âm thầm trong apply proposal. Phải trả 409 và cho UI biết "bạn đang ở version cũ".
> - Không đặt Pass Free D1 với DB demo+pilot+test chung một binding.
> - Không dùng Vite plugin assets khi config thiếu `assets` — plugin sẽ tự thêm.
> - Không chạy `db:restore:test` với đường mặc định tới DB thật.
> - Không coi 3 ca §13 đúng là model đã kiểm thực — hiện kèm nhãn "GIẢ ĐỊNH", không phải "dự báo".
> - Không mua domain, không mở public, không đổi tên brand pháp lý.
> - Không đọc code khi demo — chuyển sang evidence click được.
>
> **4. Có thể tốt hơn** — dùng Chrome channel khi có sẵn; một `money.ts` dùng chung cho cả hai sổ tiền; preview URL riêng cho investor; sensitivity strip N=0→15; snapshot config vào quote lúc issued; import preview read-only, apply là bước riêng; báo cáo tiến độ bằng "flow nào chạy được".
>
> **5. Lộ trình** — (A) §13 cho ra 3.833.333,33 không nguyên nên phải chốt quy tắc làm tròn; §9 lẫn giữa `0` và `null`; §11 dễ hiểu thành "chỉ cần batch"; §5 chỉ nêu hai kích thước; §14 cho gộp bảng nhưng §15-6 đòi cách ly tuyệt đối; §12 giới hạn 500 observation/lần nằm ngay sát giới hạn bound parameter. (B) Giai đoạn 0 một owner, giai đoạn 1 một owner với gate persistence, giai đoạn 2+ song song 3 agent + 1 integrator. (C) Build trước phỏng vấn là đúng vì code rẻ, dữ liệu thật đắt — nhưng app này không thể chứng minh thị trường; nó chứng minh "founder xây được phần mềm".
>
> **6. Lợi ích** — demo ở vườn chạy được trên laptop không cần mạng; chủ vườn thấy quyền của mình, không thấy tham số OPC founder; investor thấy quy trình ra quyết định có kiểm soát.
>
> **7. Đánh đổi** — D1 mất transaction isolation thật, chi phí chuyển khoảng một tuần viết lại tầng DB; Access Free ổn cho một email, thêm owner thứ hai phải chỉnh quyền cho đúng workspace; song song 3 agent nhanh hơn 3-4x nhưng integrator sửa rất nhiều. Không đồng ý ở một điểm: acceptance doc nên viết song song từ Phase 1, không phải để cuối.
>
> **8. Chưa xác minh** — giới hạn bound parameter và kích thước DB Free (cả hai đường dẫn tài liệu trả lỗi khi tôi đọc); quyền tạo Access application; Zero Trust team domain.
>
> **9. Checklist** — ghi `DECISIONS.md`; `src/domain/{money,economics}.ts` xanh trước mọi UI; migration 001 + seed idempotent + 3 D1 binding; lát cắt Phase 1 với persistence; acceptance doc; 17 ca §15 chạy thật; mọi mutation qua `requireRole`; allowlist + founder bootstrap idempotent; build và typecheck sạch; pilot Worker + D1 độc lập.
>
> **Chỉ số thành công** — hành trình case 1 xuyên suốt có ảnh; dữ liệu còn nguyên 100% sau restart; 0 vi phạm bất biến tiền; 0 rò rỉ cross-workspace; 100% request chưa đăng nhập bị chặn trên URL deploy.
>
> **Handoff brief** — Objective: Sa Đéc Flow với React+TS+Vite + Hono trên Workers + Static Assets + D1 + Zod, pnpm; hai khu Vận hành và Founder, 3 vai trò, 17 kiểm chứng §15 xanh, deploy private preview với Worker+D1 pilot riêng. Done means: build/typecheck/test xanh; 17 ca §15 có bằng chứng thật; chạy lại được từ README trên cả localhost DEMO và private URL. Out of scope: marketplace, ERP, ví tiền, kế toán thuế, mobile native, mua domain, AI/Zalo/email/payment, rules engine, WebSocket, tự sinh kỳ thu, đơn vị thập phân. Constraints: deploy vào tài khoản Cloudflare được cấu hình; pilot tách biệt demo/test; không đổi migration đã apply; không `:any`/`console.log`; hai sổ tiền không cộng lẫn. Stop and ask only if: Access POST bị 403; pnpm/wrangler cần login hoặc phát sinh chi phí ngoài Free; có session khác ghi cùng repo; phải rewind migration đã apply trên pilot; buộc phải mua domain hoặc mở public.
