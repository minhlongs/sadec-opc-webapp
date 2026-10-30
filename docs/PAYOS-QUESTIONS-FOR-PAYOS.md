# Hồ sơ gửi payOS — sáu nhóm câu hỏi chặn quyết định

**Người gửi: chủ dự án.** Arena không liên hệ payOS, không đăng ký, không gửi thông tin pháp nhân, không gọi API.

Mục đích: nhận **xác nhận bằng văn bản** cho sáu nhóm dưới đây trước khi thiết kế tích hợp. Mỗi nhóm tương ứng một cổng quyết định của chúng tôi. Tài liệu này đọc độc lập được, không cần hồ sơ nội bộ.

---

**Kính gửi payOS,**

Chúng tôi vận hành một sàn B2B nông sản tại Sa Đéc. Mô hình dự kiến: **sàn nhận tiền của người mua (cọc trước, phần còn lại sau khi giao và nghiệm thu), giữ lại phí nền tảng, rồi trả cho từng nhà vườn; nếu hàng không đạt thì hoàn lại cho người mua.** Tiền của người mua và tiền trả nhà vườn là hai nghĩa vụ khác nhau của cùng một đơn.

Chúng tôi đã đọc tài liệu API công khai (danh mục ở phụ lục). Trước khi thiết kế, cần sáu nhóm xác nhận sau.

---

## 1. Phạm vi mô hình

- payOS có chấp thuận cho một pháp nhân dùng **đồng thời** kênh thu và kênh chi để **nhận hộ người mua rồi trả hộ nhiều người nhận** không?
- Nếu có: điều kiện hợp đồng, hồ sơ, và hạn chế nào (ví dụ giới hạn số người nhận, thời gian giữ tiền, yêu cầu đối soát)?
- Nếu không: mô hình gần nhất mà payOS chấp thuận là gì, và phần nào của mô hình chúng tôi bị coi là không được phép?

## 2. Kênh chi, nguồn tiền và cách cấp nguồn

- Với pháp nhân của chúng tôi, **kênh chi nào** thực sự được cấp? (Chúng tôi thấy tài liệu nêu OCB, Bảo Kim, ShinhanBank, PVComBank — cần biết kênh nào áp dụng cho tài khoản của mình.)
- Tiền thu được có thể **chi trực tiếp từ tài khoản đang nhận tiền** không, hay bắt buộc phải cấp nguồn sang một nguồn chi riêng?
- Cấp nguồn bằng cách nào: chuyển khoản thủ công, hay có cơ chế tự động quét tiền từ tài khoản thu? Mất bao lâu để số dư trở nên khả dụng? Có hạn mức nạp tối thiểu/tối đa mỗi lần hoặc mỗi ngày không?
- Số dư nguồn chi có tách theo từng đơn/người nhận không, hay là một số dư chung?

## 3. Hồ sơ và cấu hình cho quyền thu – chi – hoàn

- Để có quyền **thu**, **chi** và **hoàn**, pháp nhân cần những hồ sơ nào (đăng ký kinh doanh, xác minh doanh nghiệp, liên kết tài khoản, hợp đồng riêng cho kênh chi)?
- Quyền hoàn tiền có cần phê duyệt riêng không? Hoàn được thực hiện bằng cách nào trong payOS?
- Cấu hình nào là **bắt buộc** trước khi một lệnh chi đầu tiên có thể chạy (IP allowlist, bộ khoá API riêng, tài khoản ngân hàng liên kết, hồ sơ dịch vụ)?
- Có ràng buộc nào về việc **một pháp nhân vừa thu vừa chi** trên cùng một tài khoản payOS không?

## 4. Trạng thái cuối, timeout, tra cứu và chống chi trùng

- Danh sách **đầy đủ** trạng thái của một lệnh chi là gì? Tài liệu chúng tôi đọc chỉ thấy `PROCESSING` và `SUCCEEDED` — còn trạng thái thất bại, bị từ chối, đang chờ duyệt, đã huỷ?
- Có **webhook** cho lệnh chi không? Nếu không, khuyến nghị tra cứu thế nào và tần suất bao nhiêu?
- Khi gửi lệnh mà **mất phản hồi (timeout)**: tra cứu theo `referenceId` có luôn xác định được không? Sau bao lâu thì kết quả là chắc chắn (không còn khả năng lệnh đang chạy)?
- `x-idempotency-key` được bảo đảm trong **bao lâu**? Nếu gửi lại cùng khoá sau 1 giờ, 1 ngày thì sao? Dùng lại cùng khoá với payload khác thì phản hồi là gì?
- Làm sao phân biệt "lệnh chưa từng tới payOS" với "lệnh đã tới và đang chạy" khi chỉ có `referenceId`?

## 5. Phí, hạn mức và chi phí cấp nguồn

- **Phí thu**: theo % hay cố định, tính trên số tiền hay trên mỗi giao dịch? Có thực sự miễn phí không, và miễn phí đến khi nào?
- **Phí chi**: theo lệnh hay theo lô? Có khác nhau giữa các kênh (OCB / Bảo Kim / ShinhanBank / PVComBank) không? Có phí tối thiểu mỗi lệnh?
- **Phí hoàn**, **phí nạp nguồn**, **phí rút**, **phí giao dịch thất bại / bị từ chối**?
- **Hạn mức**: mỗi giao dịch, mỗi ngày, mỗi tháng — giá trị cụ thể và có điều chỉnh được không?
- Có yêu cầu **số dư tối thiểu** ở nguồn chi không?

*(Chúng tôi cần bảng phí bằng văn bản. Giá trị xuất hiện trong ví dụ phản hồi của tài liệu API không được chúng tôi coi là báo giá.)*

## 6. Xác minh người nhận, dừng khẩn cấp và phương án thử nghiệm

- Làm sao xác minh người nhận trước khi chuyển: có kiểm tra tên chủ tài khoản không, có phát hiện tài khoản đóng/không tồn tại không? `validateDestination` kiểm tra chính xác điều gì?
- Nếu chuyển sai hoặc người nhận trả lại tiền: quy trình, thời gian xử lý và ai chịu phí?
- **Dừng khẩn cấp**: ai có quyền tắt kênh chi, thực hiện ở đâu, mất bao lâu có hiệu lực? Khi kênh dừng thì các lệnh đang chạy xử lý thế nào?
- Có cơ chế **duyệt nội bộ nhiều cấp** cho một lệnh chi trong payOS không?
- payOS công bố không có sandbox riêng. Có cách nào để chúng tôi **kiểm chứng tích hợp mà không chuyển tiền thật** (kênh thử, tài khoản thử, chế độ mô phỏng, khoá thử)?
- Nếu bắt buộc chạy thật: điều kiện cho **một phiên số tiền nhỏ có phê duyệt riêng** là gì, và ai phê duyệt?

---

Chúng tôi cần câu trả lời dạng **văn bản hoặc email**, vì các điểm trên quyết định việc có thiết kế tích hợp hay không. Nếu câu trả lời khác nhau giữa các kênh, xin ghi rõ theo từng kênh.

Trân trọng.

---

## Phụ lục — tài liệu chúng tôi đã đọc

| Tài liệu | Dùng để xác nhận điều gì |
| --- | --- |
| `payos.vn/docs/api/` | Xác thực `x-client-id` + `x-api-key`; `POST /v2/payment-requests` (chữ ký HMAC_SHA256); `GET /v2/payment-requests/{id}` trả `status`, `amountPaid`, `amountRemaining`, `transactions[]`; webhook có `signature`, `POST /confirm-webhook`; `POST /v1/payouts` có `x-idempotency-key` và `x-signature`, trường `referenceId`, `toBin`, `toAccountNumber`, `category[]`, phản hồi `approvalState`; `POST /v1/payouts/batch` với `validateDestination`; `GET /v1/payouts` lọc theo `referenceId`; `POST /v1/payouts/estimate-credit`; `GET /v1/payouts-account/balance`; danh mục mã lỗi (thiếu/trùng idempotency key, không có quyền chuyển khoản, hạn mức, số dư không đủ, kênh đã tạm dừng) |
| `payos.vn/docs/moi-truong-test/` | payOS không cung cấp sandbox riêng; thử trên môi trường thật, khuyến nghị số tiền nhỏ |
| `payos.vn/dang-ky-dich-vu-chi-ho/` | Điều kiện mở kênh chi, cách cấp nguồn, IP allowlist, bộ khoá API riêng |
| `payos.vn/docs/huong-dan-su-dung/kenh-chi/tao-kenh-chuyen-tien/` | Bước tạo kênh chuyển tiền, quản lý IP |
| `payos.vn/chi-ho/`, `payos.vn/ra-mat-kenh-chi-...`, `payos.vn/thu-ho/`, `payos.vn/phi-cong-thanh-toan/` | Nội dung giới thiệu: bốn đối tác kết nối, chi theo lô, "chi phí thấp", "miễn phí thu" — **không có số liệu** |

**Những gì chúng tôi không tìm thấy trong tài liệu công khai** (và vì vậy đang hỏi ở trên): biểu phí; trạng thái cuối đầy đủ của lệnh chi; webhook cho lệnh chi; ngữ nghĩa timeout; thời hạn bảo đảm idempotency; thủ tục kiểm thử không chuyển tiền; quy trình duyệt/dừng khẩn cấp.

---

## Ghi chú nội bộ (không gửi kèm)

- Câu **1** và **5** là hai câu chặn quyết định. Không có chúng thì không thể GO và không thể tính đúng lãi đóng góp.
- Nếu câu 1 là "không hỗ trợ": dừng nhánh payOS, chuyển sang SePay. Không chạy song song hai tích hợp.
- Không dùng giá trị trong ví dụ `estimate-credit` làm báo giá; đề nghị bảng phí riêng.
- Khi có trả lời: ghi **nguyên văn** + ngày + người trả lời vào mục 13.1 của `docs/PAYOS-B2B-DOSSIER.md`, không viết lại hồ sơ.
