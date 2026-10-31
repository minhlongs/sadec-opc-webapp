import React, { useState } from 'react';

export interface ZaloTemplateItem {
  id: string;
  title: string;
  channel: string;
  targetPersona: 'NURSERY' | 'SHOP';
  scenario: string;
  body: string;
}

export interface ObjectionHandlerItem {
  id: string;
  persona: 'NURSERY' | 'SHOP';
  objection: string;
  psychology: string;
  response: string;
}

export interface ShortVideoScriptItem {
  id: string;
  group: 'NHOM_A_NHA_VUON' | 'NHOM_B_HUB_XE_LANH' | 'NHOM_C_LOI_LO_SHOP_HCM';
  groupLabel: string;
  title: string;
  duration: string;
  hook: string;
  bodyVisual: string;
  cta: string;
}

export interface SeoAeoKeywordItem {
  id: string;
  intent: 'TRANSACTIONAL' | 'COMMERCIAL' | 'INFORMATIONAL_AEO';
  keyword: string;
  audience: string;
  targetRoute: string;
  conversionHook: string;
}

export type GtmTabId = 'zalo' | 'objections' | 'videos' | 'keywords';

export const ZALO_TEMPLATES: readonly ZaloTemplateItem[] = [
  {
    id: 'ZALO-01',
    title: 'Mẫu 1: Báo giá sỉ hàng tuần & VietQR Escrow',
    channel: 'Zalo 1-1 Chủ Shop TP.HCM',
    targetPersona: 'SHOP',
    scenario: 'Nhắn trực tiếp cho chủ shop hoa sau khi khảo sát tại chợ Hồ Thị Kỷ / Đầm Sen',
    body: `Chào anh/chị [Tên Chủ Shop - VD: Chị Hương - Tiệm Hoa Tháng Năm],
Em gửi anh/chị thông tin chi tiết & mã VietQR khóa lô hàng nhập tuần trực tiếp từ vườn Sa Đéc:

🌿 THÔNG TIN LÔ HÀNG & QUY CÁCH KIỂM ĐỊNH HUB:
• Mã lô trên sàn: SDEC-LOT-W01 (Phiên bản khóa giá: REV-a8f31c)
• Mặt hàng: Monstera Thai Constellation — Kiểng lá xuất tuần
• Nhà vườn: Vườn Kiểng Lá Út Mười — Khóm Sa Nhiên, Sa Đéc (Uy tín: 99.1%)
• Quy cách chuẩn: Loại A • Chậu ĐK 25cm • Cao 55cm • Tán rộng 50cm
• Cam kết Hub QC: 4-5 lá xẻ đều, mảng var kem >= 30%, đóng khung sắt chống dập lá.
• Xuất bến đêm Sa Đéc: 20:00 → Giao tại Sạp Chợ Hồ Thị Kỷ trước 04:30 sáng.

💰 BẢNG TÍNH TIỀN MINH BẠCH (GIÁ GỐC TẠI VƯỜN — 0Đ KÊ GIÁ):
• Số lượng đặt giữ: 30 chậu × Đơn giá gốc tại líp: 220.000 ₫/chậu = 6.600.000 ₫
• Phí dịch vụ sàn (3% — chỉ thu khi nghiệm thu đạt chuẩn): 198.000 ₫
👉 SỐ TIỀN CỌC BẢO CHỨNG CẦN THANH TOÁN (30%): 1.980.000 ₫

🔒 MÃ VIETQR BẢO CHỨNG CỌC:
• Mã QR và số tài khoản nhận cọc do hệ thống cấp khi tạo đơn — chỉ dùng mã hiển thị trên màn hình đơn đặt giữ, không dùng số tài khoản nào gửi qua tin nhắn.
• Nội dung CK bắt buộc: SDEC DEP SDEC-BK-1001
• Nếu màn hình báo "chưa cấu hình tài khoản nhận cọc": KHÔNG chuyển tiền; người phụ trách sàn sẽ liên hệ xác nhận cọc kèm mã tham chiếu ngân hàng.

🛡️ CAM KẾT BẢO VỆ CHỦ SHOP 100%:
1. Sàn ứng vốn 0đ, 0đ ăn chênh lệch kê giá. Tiền cọc giữ trong két Escrow của sàn.
2. Kiện hàng kiểm định tại Hub Sa Đéc, dán tem niêm phong QR trước khi lên xe.
3. Khi nhận hàng tại TP.HCM, nếu cây sai quy cách nụ/tán hoặc dập gãy: khấu trừ từng chậu lỗi hoặc HOÀN CỌC 100% ngay trên hệ thống.`
  },
  {
    id: 'ZALO-02',
    title: 'Mẫu 2: Chốt sổ đặt trước vụ Tết Cúc mâm xôi/Mai vàng',
    channel: 'Zalo 1-1 Đại Lý & Vựa Hoa Tết',
    targetPersona: 'SHOP',
    scenario: 'Đơn đặt trước giá trị lớn vụ Tết, nhấn mạnh cam kết mắt nụ và lịch video 15 Chạp',
    body: `Dạ em chào anh/chị [Tên Chủ Vựa/Đại Lý - VD: Anh Minh - Đại Lý Sỉ Chợ Đầm Sen],
Em gửi anh/chị Phiếu Khóa Lô Sổ Đặt Trước Vụ Tết 2027 từ thủ phủ hoa Tân Quy Đông / Tân Khánh Đông (Sa Đéc):

🌼 THÔNG TIN LÔ HOA TẾT ĐẶT TRƯỚC:
• Mã lô khóa độc quyền: SDEC-LOT-TET01
• Mặt hàng: Cúc mâm xôi đại Hàn Quốc — Loại A+
• Nhà vườn: Vườn Hoa Tư Kiểng — Tân Quy Đông, Sa Đéc
• Quy cách cam kết xuất bến: Chậu ĐK 40cm • Cao 80cm • Tán tròn mâm xôi 100cm.
• Cam kết mắt nụ: Nụ kim đều 100% toàn mâm, xử lý mầm hoa chuẩn nở rộ đúng 27–29 Tết.
• Ngày cắt bến dự kiến: 21 tháng Chạp — Giao về Chợ Hoa Đầm Sen, Quận 11.

💰 CHI TIẾT ĐƠN ĐẶT GIỮ & CỌC BẢO CHỨNG (40%):
• Mã đơn đặt giữ: SDEC-BK-1002
• Số lượng khóa sổ: 50 cặp × Đơn giá gốc cố định: 320.000 ₫/cặp = 16.000.000 ₫
• Phí dịch vụ sàn (3% khi giao thành công): 480.000 ₫
👉 TIỀN CỌC KHÓA LÔ CẦN ĐÓNG (40%): 6.400.000 ₫

🏦 MÃ VIETQR BẢO CHỨNG CỌC:
• Mã QR và số tài khoản nhận cọc do hệ thống cấp khi tạo đơn — chỉ dùng đúng mã hiển thị trên màn hình đơn đặt giữ.
• Nội dung CK: SDEC DEP SDEC-BK-1002
• Nếu màn hình báo "chưa cấu hình tài khoản nhận cọc": KHÔNG chuyển tiền; chờ người phụ trách sàn xác nhận.

✅ 3 ĐẶC QUYỀN BẢO CHỨNG SỔ TẾT SA ĐÉC FLOW:
1. Khóa cứng giá gốc và khóa giàn bằng tem QR — Nhà vườn không thể bán chồng lô khi sốt giá cận Tết.
2. Ngày 15 tháng Chạp, kỹ thuật viên Hub Sa Đéc gửi video quay trực tiếp mắt nụ qua Zalo.
3. Tới ngày giao nếu hoa nở sớm hoặc nụ điếc sai cam kết quy cách: HOÀN CỌC 100% NGAY LẬP TỨC.`
  },
  {
    id: 'ZALO-03',
    title: 'Mẫu 3: Zalo OA Broadcast lịch xe ghép đêm',
    channel: 'Zalo Official Account Broadcast (Thứ Hai & Thứ Năm)',
    targetPersona: 'SHOP',
    scenario: 'Thông báo mở lô mới hàng tuần & lịch chuyến xe tải lồng sắt xuyên đêm',
    body: `[SA ĐÉC FLOW — BẢNG GIÁ GỐC BỜ LÍP & LỊCH XE GHÉP ĐÊM TUẦN NÀY] 🚛🌿

Chào Chủ Shop! Chuyến xe tải lồng sắt chuyên dụng từ Hub Sa Đéc (Biển số 66C-189.45) sẽ xuất bến lúc 20:00 tối Thứ Tư & Thứ Bảy, cập bến Chợ Hồ Thị Kỷ — Đầm Sen — Thủ Đức trước 04:30 sáng.

🔥 3 LÔ HÀNG ĐẸP NHẤT VỪA LÊN KỆ SÁNG NAY (GIÁ GỐC TẠI VƯỜN — 0Đ KÊ GIÁ):
1️⃣ [SDEC-LOT-W01] Monstera Thai Constellation (Vườn Cô Út Mười - Sa Nhiên)
   • Quy cách: Loại A • Cao 55cm • 4-5 lá xẻ, mảng var kem >= 30%, rễ ấm chậu.
   • Giá gốc tại vườn: 220.000 ₫/chậu (MOQ từ 10 chậu • Cọc giữ lô 30%).
2️⃣ [SDEC-LOT-W02] Cau Vàng Nội Thất Chậu Sứ (Vườn Chú Tư Kiểng - Tân Quy Đông)
   • Quy cách: Loại A • Cao 90cm • Bụi 7-9 thân vàng óng, không cháy đầu lá.
   • Giá gốc tại vườn: 180.000 ₫/chậu (MOQ từ 15 chậu • Cọc giữ lô 30%).
3️⃣ [SDEC-LOT-TET01] MỞ SỔ TẾT: Cúc Mâm Xôi Đại Hàn Quốc (Tân Quy Đông)
   • Quy cách: Loại A+ • Tán tròn 100cm • Cam kết nụ kim đều 100% nở chuẩn 27-29 Tết.
   • Giá gốc khóa sổ sớm: 320.000 ₫/cặp (MOQ từ 20 cặp • Cọc bảo chứng 40%).

🛡️ TẠI SAO HƠN 100+ SHOP SÀI GÒN ĐẶT SỈ QUA SA ĐÉC FLOW?
✔️ Mua thẳng giá gốc nhà vườn — Sàn ứng vốn 0đ, chỉ thu phí dịch vụ 3% minh bạch.
✔️ Tiền cọc được ghi nhận trên sổ cái bảo chứng (mô phỏng, người phụ trách sàn xác nhận kèm mã tham chiếu ngân hàng).
✔️ Sai quy cách nụ / tán / chiều cao khi nhận hàng: Khấu trừ tại chỗ hoặc HOÀN CỌC 100%.`
  },
  {
    id: 'ZALO-04',
    title: 'Mẫu 4: Báo tin nhận cọc tươi thành công cho nhà vườn Sa Đéc',
    channel: 'Zalo 1-1 Chủ Vườn Sa Đéc',
    targetPersona: 'NURSERY',
    scenario: 'Gửi ngay khi đơn hàng chuyển sang DEPOSIT_HELD để củng cố niềm tin chắc tiền',
    body: `🎉 TIN VUI CHÚ TƯ / CÔ ÚT ƠI — ĐÃ NHẬN ĐỦ CỌC TƯƠI BẢO CHỨNG TRÊN SÀN!

Tụi con bên Sa Đéc Flow báo tin mừng cho vườn mình:
• Mã đơn hàng: SDEC-BK-1001
• Khách đặt mua: Shop Hoa Tươi Quận 1 — Giao về Chợ Hồ Thị Kỷ
• Lô hàng: 30 chậu Monstera Thai Constellation (Mã lô: SDEC-LOT-W01)
• Tổng tiền hàng gốc của vườn mình: 6.600.000 ₫

✅ TRẠNG THÁI TIỀN CỌC (ĐÃ KHÓA TRONG KÉT BẢO CHỨNG ESCROW):
• Số tiền cọc khách đã quét VietQR (30%): 1.980.000 ₫
• Mã bút toán đối soát: SDEC DEP SDEC-BK-1001 (Trạng thái: DEPOSIT_HELD)

📌 LỊCH BỨNG CHẬU & TẬP KẾT RA HUB SA ĐÉC:
• Tiền cọc tươi đã nằm chắc chắn trong tài khoản bảo chứng của sàn rồi, không sợ khách đổi ý hay bùng đơn nữa.
• Nhờ chú/cô chuẩn bị xuất đúng 30 chậu đạt chuẩn quy cách [Cao 55cm, 4-5 lá xẻ var đẹp] ra Trạm Hub Sa Đéc trước 16:00 chiều mai để anh em kiểm định dán tem QR và đưa lên xe đêm (66C-189.45).
• Sáng hôm sau khách nghiệm thu tại Sài Gòn là sàn giải ngân toàn bộ 100% tiền hàng về tài khoản ngân hàng của chú/cô ngay!`
  }
];

export const OBJECTION_HANDLERS: readonly ObjectionHandlerItem[] = [
  { id: 'OBJ-01', persona: 'NURSERY', objection: 'Chú quen bán cho thương lái cũ mấy chục năm rồi, lên sàn chi cho rắc rối!', psychology: 'Ngại thay đổi thói quen và sợ mất mối lái truyền thống nếu họ biết mình bán chỗ khác.', response: 'Dạ con hoàn toàn ủng hộ chú giữ mối lái cũ uy tín lâu năm. Sa Đéc Flow không bắt chú bỏ mối cũ hay giao độc quyền cả vườn. Nhưng mỗi vụ mình làm ra cả ngàn chậu, nếu phụ thuộc 100% vô 1–2 ông lái, lỡ năm nay họ kẹt vốn ép giá thì mình trở tay không kịp. Chú cứ tách ra 10–20% số lượng trên líp (50–100 chậu) đưa lên sàn để mở thêm nguồn khách sạp Sài Gòn trả đúng giá gốc, lại cầm chắc 40% cọc tươi trong tay!' },
  { id: 'OBJ-02', persona: 'NURSERY', objection: 'Chú lớn tuổi rồi, tay chân dính sình đất không biết xài công nghệ hay bấm điện thoại đâu!', psychology: 'Sợ thao tác phức tạp, sợ bấm nhầm mất tiền hoặc không biết đăng bài.', response: 'Dạ chú khỏi lo chuyện bấm máy! Tụi con là người địa phương nằm vùng ở Tân Quy Đông - Sa Nhiên này luôn. Việc đo cây, chụp hình, đăng lô lên sàn là tụi con làm tận tay cho chú ngay tại bờ líp. Điện thoại của chú chỉ cần dùng đúng 2 việc: một là mở Zalo coi tin nhắn báo "Đã nhận cọc bảo chứng", hai là nghe tiếng "ting ting" ngân hàng báo tiền về khi giao hàng xong!' },
  { id: 'OBJ-03', persona: 'NURSERY', objection: 'Cọc giữ ở trên sàn của tụi bây chứ có vô túi chú liền đâu mà kêu là chắc tiền?', psychology: 'Chưa hiểu cơ chế tài khoản bảo chứng Escrow, sợ sàn giữ tiền rồi dây dưa không trả.', response: 'Chú hỏi câu này rất sát thực tế! Khi khách quét mã VietQR đóng 30–50% cọc, khoản đó được ghi nhận trên sổ cái theo mã đơn SDEC-BK của vườn chú (sổ cái mô phỏng, người phụ trách sàn xác nhận) — bản thân người mua cũng không tự ý rút lại được nếu họ đổi ý bỏ bom! Chú chỉ cần giao cây ra Hub Sa Đéc đúng chiều cao, đúng mắt nụ như đã đăng là quyền nhận tiền thuộc về chú 100%, sáng hôm sau sàn xác nhận giải ngân kèm biên lai sổ cái rõ ràng (bút toán do người xác nhận, không tự động).' },
  { id: 'OBJ-04', persona: 'NURSERY', objection: 'Lỡ chở cây lên Sài Gòn rồi trên đó chủ shop kiếm chuyện chê ỏng chê eo để trừ tiền của chú thì sao?', psychology: 'Từng bị vựa trên TP.HCM chơi chiêu nhận hàng xong mới báo cây héo/gãy để trừ tiền vô tội vạ.', response: 'Đó chính là lý do tụi con đặt Trạm Hub Kiểm Định ngay tại Sa Đéc đó chú! Lúc chú chở cây ra Hub Sa Đéc, nhân viên kỹ thuật đo thước, đếm nụ ngay trước mặt chú. Đạt chuẩn là bấm xác nhận VERIFIED_OK và dán tem QR niêm phong kiện hàng tại bến. Lên tới Sài Gòn nếu do xe tải dằn xóc làm gãy đọt, hệ thống quy trách nhiệm cho bên vận chuyển (LOGISTICS), tuyệt đối không khấu trừ vô tiền cây của nhà vườn!' },
  { id: 'OBJ-05', persona: 'NURSERY', objection: 'Giờ mới tháng 10, tháng 11 Âm lịch, đợi gần Tết coi giá thị trường lên xuống sao rồi mới báo giá bán chứ!', psychology: 'Tâm lý găm hàng chờ sốt giá ngày 25–27 Tết, nhưng quên mất rủi ro ế hàng dội chợ ngày 29 Tết.', response: 'Dạ tâm lý ai trồng bông Tết cũng mong trúng giá ngày 25–26 Chạp hết chú. Nhưng giữ tới sau 23 Tết, thương lái thấy mình còn đầy trên giàn là họ bắt tay nhau ghìm giá xuống sát đáy. Khôn ngoan nhất là chú chia làm 2 phần: 50% sản lượng đưa lên Sổ Đặt Trước Sa Đéc Flow ngay bây giờ với mức giá lời tốt và thu chắc 40–50% tiền cọc bảo chứng thu hồi vốn phân thuốc trước; 50% còn lại chú giữ canh thị trường sát Tết!' },
  { id: 'OBJ-06', persona: 'SHOP', objection: 'Chị lấy vựa quen trên Sài Gòn gọi cái có liền, thiếu tiền cuối tháng trả, mắt gì phải đặt qua sàn rồi đóng cọc trước?', psychology: 'Thích sự tiện lợi và mua gối đầu công nợ của vựa trung gian, chưa tính kỹ phần chi phí chênh lệch bị ăn dày.', response: 'Dạ em hiểu cái tiện của việc lấy vựa quen gối đầu công nợ. Nhưng vựa cho chị nợ 2 tuần mà mỗi chậu Cau vàng hay Monstera họ kê giá thêm 40.000đ – 70.000đ/chậu (đội giá 25–30%). Mỗi tháng nhập 200 chậu là chị mất đứt 8 đến 14 triệu tiền lời! Đặt trên Sa Đéc Flow chị mua thẳng giá gốc tại vườn, phí sàn chỉ 3%. Chị chỉ cọc 30% lúc giữ lô, sáng mai nhận hàng kiểm xong mới thanh toán 70% còn lại.' },
  { id: 'OBJ-07', persona: 'SHOP', objection: 'Mua cây qua mạng toàn treo đầu dê bán thịt chó! Hình chụp thì mướt rượt, lúc giao tới sạp toàn cây còi, lá rách!', psychology: 'Từng bị lừa khi mua qua các hội nhóm Facebook/Zalo tự phát không có khâu kiểm định.', response: 'Chị nói quá đúng nếu đó là mua qua cò trên Facebook! Còn ở Sa Đéc Flow, tụi em khóa chặt 3 thứ: (1) Mỗi lô có mã revision và thông số đo bằng thước dây bắt buộc (cao, tán, nụ); (2) Trước khi lên xe tại Sa Đéc, nhân viên Hub kiểm từng chậu, không đúng thông số là chặn lại tại bến; (3) Tiền cọc nằm ở két Escrow của sàn, hàng tới sạp sai quy cách cam kết chị bấm từ chối là hoàn cọc 100% ngay!' },
  { id: 'OBJ-08', persona: 'SHOP', objection: 'Sàn kêu không ăn chênh lệch mà thu phí dịch vụ 2–5%, vậy cộng vô cũng mắc hơn tự đi xuống Sa Đéc mua!', psychology: 'So sánh phí sàn 3% với việc tự bắt xe xuống Sa Đéc mua trực tiếp.', response: 'Nếu chị nhập nguyên chiếc xe tải 5 tấn thì tự đi rất đáng. Nhưng với đơn hàng tuần 15–50 chậu, một chuyến đi về Sài Gòn - Sa Đéc mất đứt 1 ngày bỏ sạp, tốn 1,5 triệu tiền xăng xe, chưa kể thuê xe lẻ chở 30 chậu bị tính cước cắt cổ! Trên Sa Đéc Flow, đơn 5.000.000đ phí sàn 3% chỉ có 150.000đ — chưa bằng tiền trạm thu phí cao tốc, lại có người kiểm từng mắt nụ và bảo lãnh tiền cọc 100%.' },
  { id: 'OBJ-09', persona: 'SHOP', objection: 'Xe tải ghép hàng chạy đêm từ Đồng Tháp lên Sài Gòn hay làm dập lá, bể bầu lắm, tới nơi ai chịu?', psychology: 'Đau đầu vì chất lượng vận chuyển của các chành xe tải hàng tạp truyền thống nhét hoa kiểng chung với trái cây.', response: 'Các chành xe thông thường chất chồng chậu cây lên nhau nên mới bị hầm hơi và dập lá. Tuyến xe đêm của Hub Sa Đéc Flow là xe chuyên chở hoa kiểng: cố định trong khung lồng sắt phân tầng và bọc lưới bảo vệ tán. Đặc biệt, biên bản nghiệm thu có mục phân định lỗi LOGISTICS: sáng nhận hàng nếu có chậu gãy đọt do xe chạy ẩu, chị tích chọn lỗi vận chuyển là tiền chậu hư được trừ thẳng khỏi hóa đơn ngay lập tức!' },
  { id: 'OBJ-10', persona: 'SHOP', objection: 'Đặt trước hoa Tết từ tháng 11 Âm lịch rủi ro lắm, lỡ tới 25 Tết thời tiết thất thường hoa nở sớm hoặc nụ điếc thì mất trắng tiền cọc à?', psychology: 'Nỗi sợ lớn nhất của dân buôn hoa Tết về rủi ro sinh học của cây trồng và rủi ro kẹt vốn.', response: 'Đây chính là điểm ăn tiền nhất của Sổ Đặt Trước Vụ Tết Sa Đéc Flow! Hợp đồng đơn hàng ghi rõ Cam kết tiêu chuẩn nụ khi xuất bến (VD: Tán tròn 100cm, nụ kim đều 100%, nở đúng 27–29 Tết). Tiền cọc 40% giữ trong két Escrow của sàn. Ngày 15 tháng Chạp, Hub Sa Đéc gửi video kiểm tra mắt nụ thực tế. Nếu tới ngày xuất bến lô cây bị nở sớm hoặc nụ điếc (REJECTED_NURSERY_FAULT), sàn hoàn trả 100% tiền cọc về tài khoản cho anh/chị!' }
];

export const SHORT_VIDEO_SCRIPTS: readonly ShortVideoScriptItem[] = [
  { id: 'VID-01', group: 'NHOM_A_NHA_VUON', groupLabel: 'Nhóm A: Nhà Vườn Sa Đéc', title: 'Kịch bản 01: Tờ giấy cọc viết tay và giọt nước mắt chiều 27 Tết', duration: '45 giây', hook: 'Cọc miệng 5 triệu, bỏ bom 500 giỏ cúc! Tờ giấy viết tay này từng lấy đi cái Tết của biết bao nhà vườn Sa Đéc!', bodyVisual: 'Bàn tay chú Sáu xé tờ giấy cọc tay trước giàn cúc Tân Quy Đông → Nhân viên Sa Đéc Flow đo tán 80cm, gắn thẻ QR LOT-CMX-2027 → Điện thoại báo "Ting ting: +22.500.000đ Ký quỹ VietQR Escrow 50%".', cta: 'Làm bông cực 6 tháng trời, đừng giao số phận cho tờ giấy tay. Lên Sa Đéc Flow — Nhận cọc tươi 30–50%, chắc tiền mới giữ giàn!' },
  { id: 'VID-02', group: 'NHOM_A_NHA_VUON', groupLabel: 'Nhóm A: Nhà Vườn Sa Đéc', title: 'Kịch bản 02: "Đợi hoa nở bung rồi ép giá một nửa" — Chiêu bài cũ hết thời!', duration: '40 giây', hook: 'Đợi tới 26 Tết hoa hé nở mới xuống vườn trả giá một nửa — Chiêu ép giá nhà vườn này năm nay hết đất sống rồi!', bodyVisual: 'Thương lái đòi trả 40k/cặp → Chủ vườn chỉ vào bảng niêm yết "LÔ ĐÃ KHÓA CỌC 40% TRÊN SA ĐÉC FLOW — MÃ LOT-SN-089" chốt giá 180.000đ/cặp bất biến → Xe Hub Sa Đéc lùi vào bốc hàng.', cta: 'Khóa giá từ tháng Chạp, cọc nằm trong tài khoản bảo chứng. Nhà vườn Sa Đéc bấm vào nút Zalo bên dưới ngay!' },
  { id: 'VID-03', group: 'NHOM_A_NHA_VUON', groupLabel: 'Nhóm A: Nhà Vườn Sa Đéc', title: 'Kịch bản 03: Bàn tay lấm bùn lúc 2 giờ sáng và tiếng "Ting Ting" ấm lòng', duration: '35 giây', hook: 'Hai giờ sáng ngoài đồng Sa Đéc, thứ nhà vườn sợ nhất không phải thức đêm, mà là thức trắng 180 đêm rồi bị bùng cọc!', bodyVisual: 'Vợ chồng nhà vườn Tân Khánh Đông soi đèn pin kiểm tra mắt nụ mai vàng lúc 2h sáng → Sáng hôm sau kỹ thuật viên chụp macro mắt nụ lên sàn → Chủ vựa Thủ Đức quét VietQR đặt cọc 35%.', cta: 'Sa Đéc Flow giữ trọn giọt mồ hôi nhà vườn bằng cọc thật 30–50%. Gửi mẫu mai vàng, cúc mâm xôi lên sàn ngay hôm nay!' },
  { id: 'VID-04', group: 'NHOM_A_NHA_VUON', groupLabel: 'Nhóm A: Nhà Vườn Sa Đéc', title: 'Kịch bản 04: Tại sao 100 giỏ kiểng lá xuất tuần không còn sợ "giam công nợ 3 tháng"?', duration: '45 giây', hook: 'Giao 100 chậu kiểng lá lên Sài Gòn, tiền phân thuốc phải trả tiền mặt mà tiền bông bị ngâm 3 tháng!', bodyVisual: 'Chủ vườn ném cuốn sổ ghi nợ vào ngăn kéo → Đăng lô WEEKLY_CATALOG Monstera ĐK 25cm cao 60cm → Đêm thứ Tư dán QR lên xe lạnh → Sáng thứ Năm shop TP.HCM nhận hàng, giải ngân 100% tức thì.', cta: 'Xuất kiểng lá hàng tuần, tiền về liền tay ngay khi xe cập bến Sài Gòn. Vào Sa Đéc Flow mở gian hàng nhà vườn ngay!' },
  { id: 'VID-05', group: 'NHOM_A_NHA_VUON', groupLabel: 'Nhóm A: Nhà Vườn Sa Đéc', title: 'Kịch bản 05: Phỏng vấn thật 100% — "Năm nay chú Bảy ngủ ngon trước đêm 23 tháng Chạp!"', duration: '50 giây', hook: 'Mọi năm tầm rằm tháng Chạp là tui mất ngủ, sợ lái hổng xuống. Năm nay 80% giàn này nhận cọc VietQR hết trơn rồi!', bodyVisual: 'Chú Bảy (60 tuổi, áo bà ba nâu) bên 2.000 giỏ cúc mâm xôi giơ điện thoại mở màn hình Sa Đéc Flow: Lô 200 cặp đi Quận 10 (Đã cọc 40%), Lô 150 cặp đi Bình Thạnh (Đã cọc 50%) kèm tem niêm phong.', cta: 'Nhà vườn chỉ việc trồng hoa đẹp, chuyện giữ cọc và xe cộ để Sa Đéc Flow lo. Bà con bấm nút Gửi Lô Hoa ngay bên dưới nhé!' },
  { id: 'VID-06', group: 'NHOM_B_HUB_XE_LANH', groupLabel: 'Nhóm B: Đêm Kiểm Định Hub & Xe Lạnh', title: 'Kịch bản 06: 23h đêm tại Hub Sa Đéc — Chốt chặn "Không đạt nụ, trả về vườn ngay!"', duration: '45 giây', hook: '23 giờ đêm tại Hub Sa Đéc: Giỏ nào lệch tán, thiếu nụ hay sâu lá — Loại ngay tại chỗ, tuyệt đối không cho lên xe về Sài Gòn!', bodyVisual: 'QC cầm thước đo đường kính chậu, đếm mật độ nụ trên 10cm² tán cúc → Đẩy 4 giỏ lệch tán sang khu LOẠI → Giỏ đạt chuẩn Hạng A được lồng lưới, bấm tem QR niêm phong chuyển trạng thái QC_PASSED.', cta: 'Chủ shop Sài Gòn nằm ở nhà vẫn thấy tận mắt giỏ hoa qua 3 vòng kiểm định. Đặt sỉ giá gốc, sai nụ hoàn cọc 100% tại Sa Đéc Flow!' },
  { id: 'VID-07', group: 'NHOM_B_HUB_XE_LANH', groupLabel: 'Nhóm B: Đêm Kiểm Định Hub & Xe Lạnh', title: 'Kịch bản 07: Giải phẫu chuyến xe tải lạnh Cross-Docking chạy xuyên đêm Sa Đéc → TP.HCM', duration: '40 giây', hook: 'Tại sao hoa bạn nhập về Sài Gòn bị héo rũ và gãy tới 15%, còn hoa đi xe ghép Sa Đéc Flow tươi nguyên như vừa bứng dưới giàn?', bodyVisual: 'Split-screen xe mui bạt nhồi nhét vs kệ khung sắt 3 tầng Cross-Docking Sa Đéc Flow → Đồng hồ nhiệt độ thùng xe giữ 18–22°C, độ ẩm 75% → 4h sáng hạ bửng nâng thủy lực êm ái tại Quận 10.', cta: 'Ghép xe từ 10 giỏ, phí vận chuyển tiết kiệm 30%, tỷ lệ gãy dập dưới 1%. Xem lịch xe chạy tuần này tại trang Khám Phá!' },
  { id: 'VID-08', group: 'NHOM_B_HUB_XE_LANH', groupLabel: 'Nhóm B: Đêm Kiểm Định Hub & Xe Lạnh', title: 'Kịch bản 08: Tem QR Niêm Phong — Vũ khí chấm dứt nạn "Xem mẫu Hạng A, giao hàng Hạng C"', duration: '35 giây', hook: 'Coi hình Zalo là hoa Hạng Nhất, lúc nhận hàng tại Sài Gòn lại là hoa dạt Hạng Ba! Đây là cách Sa Đéc Flow khóa chặt trò tráo hàng!', bodyVisual: 'Giật thử dây rút nhựa niêm phong mã QR trên gốc mai vàng không đứt → Minh họa Chốt 0 (tại vườn), Chốt 1 (Hub Sa Đéc khóa niêm phong), Chốt 2 (Shop Quận 7 quét QR hiện ảnh đối chiếu).', cta: 'Sai mã QR hoặc sai quy cách nụ trên biên bản — Bấm nút từ chối nhận, hoàn cọc 100% trong ngày! Nhập hoa minh bạch tại Sa Đéc Flow!' },
  { id: 'VID-09', group: 'NHOM_B_HUB_XE_LANH', groupLabel: 'Nhóm B: Đêm Kiểm Định Hub & Xe Lạnh', title: 'Kịch bản 09: Hành trình 5 tiếng từ bờ kênh Tân Quy Đông đến cửa shop hoa Quận 1', duration: '45 giây', hook: 'Chỉ 5 tiếng rưỡi đồng hồ! Hành trình một lô Hồng Cổ Sa Đéc đi thẳng từ bờ kênh Tân Quy Đông tới cửa tiệm hoa Quận 1 không qua trung gian!', bodyVisual: 'Time-lapse 21:00 nhà vườn cắt tỉa tập kết → 23:00 Hub Sa Đéc nghiệm thu độ hé nụ hồng, đóng lồng kẽm ghép đơn cho 8 shop → 04:30 xe dừng trước cửa shop Nguyễn Thị Minh Khai, cánh hoa còn đọng sương.', cta: 'Cắt bỏ 3 tầng thương lái, giữ trọn độ tươi và biên lợi nhuận cho shop của bạn. Đặt lịch ghép xe chuyến 23h tối nay trên Sa Đéc Flow!' },
  { id: 'VID-10', group: 'NHOM_B_HUB_XE_LANH', groupLabel: 'Nhóm B: Đêm Kiểm Định Hub & Xe Lạnh', title: 'Kịch bản 10: Chuyện gì xảy ra nếu hoa về tới TP.HCM bị gãy tán hoặc nở sớm?', duration: '45 giây', hook: 'Mua qua thương lái, hoa gãy ráng mà chịu! Còn mua qua Sa Đéc Flow, hoa gãy cành hay nở sớm giải quyết trong đúng 60 giây!', bodyVisual: 'Chủ shop phát hiện 2 chậu trạng nguyên gãy ngọn cạnh xe tải → Mở Chốt 2 (Buyer Delivery Check) quét QR chụp ảnh → Bấm "Khấu Trừ Nghiệm Thu" → Hoàn trả tự động tiền 2 chậu lỗi từ quỹ VietQR Escrow.', cta: 'Tiền cọc nằm trong két bảo chứng, chỉ giải ngân cho những chậu hoa đạt chuẩn 100%. Chủ shop Sài Gòn yên tâm nhập sỉ ngay!' },
  { id: 'VID-11', group: 'NHOM_C_LOI_LO_SHOP_HCM', groupLabel: 'Nhóm C: Bài Toán Lời Lỗ Shop TP.HCM', title: 'Kịch bản 11: Bảng tính 100 giỏ Cúc Mâm Xôi — Bạn đang "cúng" 7,5 triệu cho trung gian!', duration: '50 giây', hook: 'Nhập 100 cặp cúc mâm xôi bán Tết, chưa biết lời bao nhiêu nhưng bạn đã mất đứt 7 triệu rưỡi cho 3 tầng trung gian!', bodyVisual: 'Bảng trắng ghi "-7.500.000đ": Mua qua lái chợ sỉ (Gốc 160k + cò 15k + xe 25k + vựa 35k = 235k/cặp) vs Đặt trực tiếp Sa Đéc Flow (Gốc 160k + phí sàn 3% + xe ghép = 185k/cặp).', cta: 'Tiết kiệm 50.000đ mỗi cặp, 100 cặp giữ lại 5 đến 7 triệu tiền lời ròng trong túi! Bấm vào link lấy báo giá gốc Sa Đéc ngay!' },
  { id: 'VID-12', group: 'NHOM_C_LOI_LO_SHOP_HCM', groupLabel: 'Nhóm C: Bài Toán Lời Lỗ Shop TP.HCM', title: 'Kịch bản 12: Cơn ác mộng "Cúc mâm xôi nở xòe từ 23 Tết" của dân buôn hoa thời vụ', duration: '40 giây', hook: 'Lý do 70% người buôn hoa Tết lần đầu tại Sài Gòn lỗ vốn: Đặt hàng qua tin nhắn mà không khóa chuẩn quy cách nụ!', bodyVisual: 'So sánh 2 giỏ cúc: 1 giỏ nở bung nhụy đen ngày 24 Tết vs 1 giỏ nụ hạt tiêu hé vàng 20% chuẩn Hạng A của Sa Đéc Flow có trường bud_specification, canopy_cm: 80, height_cm: 55.', cta: 'Đặt hoa Tết phải khóa bằng chỉ số nụ và bảo chứng hoàn cọc 100% nếu giao hoa nở sớm. Xem ngay bảng lô Tết 2027 tại Sa Đéc Flow!' },
  { id: 'VID-13', group: 'NHOM_C_LOI_LO_SHOP_HCM', groupLabel: 'Nhóm C: Bài Toán Lời Lỗ Shop TP.HCM', title: 'Kịch bản 13: Chủ shop hoa nhỏ lẻ lấy 15–20 chậu làm sao có giá sỉ tận vườn Sa Đéc?', duration: '40 giây', hook: 'Shop nhỏ lấy 15–20 chậu vẫn hưởng đúng giá gốc tại bờ líp Sa Đéc — Bí quyết nằm ở cơ chế Gom Đơn Cross-Docking!', bodyVisual: 'Chủ shop hoa 25m² tại Phú Nhuận mở danh mục WEEKLY_CATALOG MOQ 10–20 chậu → Đơn 20 chậu được ghép chung xe tải lạnh với 15 shop khác ở Tân Bình, Quận 3, Quận 10 → Sáng sớm giao tận cửa.', cta: 'Không cần ôm hàng trăm chậu mới có giá gốc. Ghép đơn sỉ từ 10 chậu mỗi tuần trên Sa Đéc Flow — Bấm xem báo giá ngay!' },
  { id: 'VID-14', group: 'NHOM_C_LOI_LO_SHOP_HCM', groupLabel: 'Nhóm C: Bài Toán Lời Lỗ Shop TP.HCM', title: 'Kịch bản 14: So sánh 1 triệu tiền hàng ở chợ sỉ lúc 3h sáng vs 1 triệu đặt trên Sa Đéc Flow', duration: '45 giây', hook: 'Cầm 1 triệu đồng đi chợ sỉ lúc 3 giờ sáng dầm mưa giành giật, so với ngồi tại tiệm đặt Sa Đéc Flow — Đâu mới là cách làm giàu?', bodyVisual: 'Cảnh đi chợ đêm mưa lất phất chở xe máy gãy mất 2 chậu vs Ngồi tại shop mở /discover xem điểm uy tín fulfillment_score_bps 98,5%, quét VietQR cọc 30%, lấy được nhiều hơn 25% số chậu.', cta: 'Dành sức mà cắm hoa và chốt khách lẻ, chuyện nguồn hàng giá gốc tận vườn cứ để Sa Đéc Flow gánh! Vào xem danh mục lô mới nhất!' },
  { id: 'VID-15', group: 'NHOM_C_LOI_LO_SHOP_HCM', groupLabel: 'Nhóm C: Bài Toán Lời Lỗ Shop TP.HCM', title: 'Kịch bản 15: Trải nghiệm quét VietQR Escrow — "Không đúng nụ cam kết, tiền cọc tự quay về!"', duration: '40 giây', hook: 'Chuyển cọc 10 triệu mua hoa qua mạng cho người lạ thì run tay, nhưng quét VietQR Escrow trên Sa Đéc Flow thì kê cao gối ngủ!', bodyVisual: 'Quét mã VietQR động trên phiếu đặt lô 30 triệu → Giải thích khóa tiền theo Immutable Revision → Minh họa 2 nhánh: Đạt chuẩn nụ giải ngân cho vườn / Hoa nở sớm hoàn cọc 100% cho shop.', cta: 'Bộ đôi Chắc tiền cho nhà vườn — Giá gốc, an toàn cọc cho chủ shop. Truy cập Sa Đéc Flow khóa lô hoa đẹp nhất mùa này ngay!' }
];

export const SEO_AEO_KEYWORDS: readonly SeoAeoKeywordItem[] = [
  { id: 'KW-01', intent: 'TRANSACTIONAL', keyword: 'Nguồn sỉ cúc mâm xôi Sa Đéc', audience: 'Chủ shop hoa, dân buôn Tết TP.HCM', targetRoute: '/discover?mode=SEASONAL_PREORDER', conversionHook: 'Mua giá gốc tận bờ líp Tân Quy Đông, khóa cọc VietQR 30–50%, sai nụ hoàn cọc 100%.' },
  { id: 'KW-02', intent: 'TRANSACTIONAL', keyword: 'Sỉ kiểng lá Sa Đéc đi TP.HCM', audience: 'Shop cây cảnh nội thất Quận 1, 3, 7, Phú Nhuận', targetRoute: '/discover?mode=WEEKLY_CATALOG', conversionHook: 'Đặt sỉ MOQ từ 10 chậu, ghép xe tải lạnh thứ Tư & thứ Bảy, giao tận cửa tiệm lúc 4h30 sáng.' },
  { id: 'KW-03', intent: 'TRANSACTIONAL', keyword: 'Đặt mai vàng Tết giá gốc', audience: 'Vựa hoa Tết, doanh nghiệp mua biếu tặng', targetRoute: '/discover?mode=SEASONAL_PREORDER', conversionHook: 'Mai giảo Thủ Đức gốc Sa Đéc, niêm phong mã QR từng gốc, cam kết mật độ nụ kim.' },
  { id: 'KW-04', intent: 'TRANSACTIONAL', keyword: 'Lấy sỉ hoa kiểng tận vườn Sa Đéc', audience: 'Chủ shop hoa muốn cắt bỏ trung gian chợ sỉ', targetRoute: '/discover', conversionHook: 'Cắt bỏ 3 tầng thương lái, tiết kiệm 25–30% giá vốn, xem trực tiếp điểm uy tín nhà vườn.' },
  { id: 'KW-05', intent: 'TRANSACTIONAL', keyword: 'Sỉ cúc mâm xôi Hàn Quốc đa sắc Sa Đéc', audience: 'Shop hoa cao cấp, khu đô thị TP.HCM', targetRoute: '/discover?mode=SEASONAL_PREORDER', conversionHook: 'Chuẩn màu tím/đỏ/hồng, tán tròn 70–80cm, nghiệm thu tại Hub Sa Đéc trước khi lên xe.' },
  { id: 'KW-06', intent: 'TRANSACTIONAL', keyword: 'Nguồn sỉ hồng cổ Sa Đéc giá vườn', audience: 'Shop hoa tươi, tiệm cà phê sân vườn Sài Gòn', targetRoute: '/discover?mode=WEEKLY_CATALOG', conversionHook: 'Hồng cổ Sa Đéc & hồng lửa đang ôm nụ, đi xe lạnh giữ nguyên sương sớm, không gãy rụng.' },
  { id: 'KW-07', intent: 'TRANSACTIONAL', keyword: 'Nhập sỉ cây công trình cảnh quan Sa Đéc', audience: 'Nhà thầu cảnh quan, trang trí tòa nhà', targetRoute: '/discover', conversionHook: 'Đồng đều kích thước 100%, báo giá bất biến xuất chuẩn A4, giao đúng tiến độ thi công.' },
  { id: 'KW-08', intent: 'TRANSACTIONAL', keyword: 'Đặt trước hoa Tết Sa Đéc không sợ bùng', audience: 'Người buôn hoa Tết thời vụ tại Sài Gòn', targetRoute: '/discover?mode=SEASONAL_PREORDER', conversionHook: 'Hợp đồng lô điện tử, bảo chứng cọc VietQR Escrow, loại bỏ hoàn toàn rủi ro tráo hàng dạt.' },
  { id: 'KW-09', intent: 'TRANSACTIONAL', keyword: 'Mua sỉ trầu bà monstera vườn Sa Đéc', audience: 'Shop kiểng lá TP.HCM, Bình Dương', targetRoute: '/discover?mode=WEEKLY_CATALOG', conversionHook: 'Lá bóng khỏe, chọn lọc Hạng A tại vườn Sa Nhiên, ghép chuyến xe lạnh tiết kiệm 30% cước.' },
  { id: 'KW-10', intent: 'TRANSACTIONAL', keyword: 'Sàn giao dịch hoa kiểng B2B Sa Đéc', audience: 'Đại lý cấp 1, chuỗi cửa hàng hoa', targetRoute: '/discover', conversionHook: 'Sàn B2B đầu tiên kết nối thẳng Làng hoa Sa Đéc → TP.HCM với cơ chế 3 chốt chặn kiểm định.' },
  { id: 'KW-11', intent: 'COMMERCIAL', keyword: 'Báo giá cúc mâm xôi 2027', audience: 'Dân buôn hoa Tết đang lập bảng tính vốn', targetRoute: '/discover & /llms-full.txt', conversionHook: 'Bảng giá gốc niêm yết theo số nguyên VND từng lô, công khai phí sàn 2–5% và tỷ lệ cọc.' },
  { id: 'KW-12', intent: 'COMMERCIAL', keyword: 'Xe ghép hoa kiểng Sa Đéc về Sài Gòn', audience: 'Chủ shop nhỏ lẻ ngại thuê nguyên chuyến xe', targetRoute: '/discover', conversionHook: 'Xe tải lạnh kệ sắt 3 tầng chạy xuyên đêm 23h00 → 04h30, nhận ghép từ 10 giỏ, tỷ lệ dập < 1%.' },
  { id: 'KW-13', intent: 'COMMERCIAL', keyword: 'Giá sỉ hoa Tết tại vườn Sa Đéc hôm nay', audience: 'Thương nhân khảo giá đầu vụ tháng 10–12 ÂL', targetRoute: '/api/public/catalog & /discover', conversionHook: 'Dữ liệu tồn kho và giá gốc cập nhật thời gian thực kèm mã revision chống lệch giá.' },
  { id: 'KW-14', intent: 'COMMERCIAL', keyword: 'So sánh giá hoa chợ Hồ Thị Kỷ và vườn Sa Đéc', audience: 'Chủ shop hoa muốn tối ưu biên lợi nhuận', targetRoute: '/discover', conversionHook: 'Bóc tách bài toán 100 cặp cúc: Giữ lại 5–7,5 triệu tiền lời nhờ cắt cầu thương lái.' },
  { id: 'KW-15', intent: 'COMMERCIAL', keyword: 'Vựa hoa kiểng uy tín Tân Quy Đông Sa Đéc', audience: 'Người mua sỉ tìm nhà vườn làm ăn chuẩn chỉ', targetRoute: '/discover', conversionHook: 'Chỉ hiển thị nhà vườn có fulfillment_score_bps (Điểm hoàn thành đơn) minh bạch trên 95%.' },
  { id: 'KW-16', intent: 'COMMERCIAL', keyword: 'Chi phí vận chuyển hoa từ Đồng Tháp lên TP.HCM', audience: 'Người mua sỉ tính giá vốn landed-cost', targetRoute: '/discover', conversionHook: 'Gom hàng Cross-Docking tại Hub Sa Đéc giúp giảm 30% chi phí vận tải mỗi chậu.' },
  { id: 'KW-17', intent: 'COMMERCIAL', keyword: 'Bảng giá sỉ vạn thọ trạng nguyên Tết 2027', audience: 'Đơn vị trang trí đường hoa, sự kiện Tết', targetRoute: '/discover?mode=SEASONAL_PREORDER', conversionHook: 'Báo giá MOQ tự động (sample_moq_quote), cố định giá ngay khi khóa cọc.' },
  { id: 'KW-18', intent: 'COMMERCIAL', keyword: 'Nhà vườn cung cấp cây văn phòng giá sỉ miền Nam', audience: 'Công ty dịch vụ cho thuê cây văn phòng', targetRoute: '/discover?mode=WEEKLY_CATALOG', conversionHook: 'Nguồn cung ổn định 52 tuần/năm từ Tân Khánh Đông & Sa Nhiên, hóa đơn chứng từ rõ ràng.' },
  { id: 'KW-19', intent: 'COMMERCIAL', keyword: 'Kinh nghiệm đặt cọc hoa Tết Sa Đéc an toàn', audience: 'Người mới buôn hoa Tết sợ mất cọc hoặc hoa nở sớm', targetRoute: '/docs.md & /discover', conversionHook: 'Quy trình VietQR Escrow + 3 Chốt kiểm định: Không đạt quy cách nụ hoàn cọc 100%.' },
  { id: 'KW-20', intent: 'COMMERCIAL', keyword: 'Tìm đầu ra cho nhà vườn hoa kiểng Sa Đéc', audience: 'Chủ vườn tại Sa Đéc bị thương lái ép giá', targetRoute: '/discover', conversionHook: 'Chắc tiền cọc tươi 30–50% trong tài khoản bảo chứng, không lo thương lái bỏ bom 27 Tết.' },
  { id: 'KW-21', intent: 'INFORMATIONAL_AEO', keyword: 'Tiêu chuẩn nụ cúc mâm xôi giao Tết chuẩn ngày', audience: 'Người mua sỉ kiểm tra chất lượng hoa', targetRoute: '/discover & FAQ Schema', conversionHook: 'Giải thích chuẩn "Nụ hạt tiêu / Nụ xé kiến hé vàng 20%" từ ngày 23–25 tháng Chạp.' },
  { id: 'KW-22', intent: 'INFORMATIONAL_AEO', keyword: 'Cách kiểm tra mai vàng đạt chuẩn nụ Tết', audience: 'Vựa mai và người mua sỉ TP.HCM', targetRoute: '/discover', conversionHook: 'Tiêu chuẩn mắt nụ kim, vỏ trấu và cách quét tem QR niêm phong đối chiếu tại Chốt 2.' },
  { id: 'KW-23', intent: 'INFORMATIONAL_AEO', keyword: 'Tại sao hoa vận chuyển từ miền Tây về Sài Gòn bị héo', audience: 'Chủ shop hoa gặp vấn đề hao hụt hàng', targetRoute: '/discover', conversionHook: 'Giải pháp thùng lạnh 18–22°C + kệ sắt phân tầng chống hầm hơi trên cao tốc.' },
  { id: 'KW-24', intent: 'INFORMATIONAL_AEO', keyword: 'Quy trình kiểm định hoa kiểng xuất vườn Sa Đéc', audience: 'Khách hàng doanh nghiệp & AI Agents', targetRoute: '/docs.md & /llms-full.txt', conversionHook: 'Chi tiết 3 chốt chặn: Chốt 0 (Gắn QR tại vườn) → Chốt 1 (Hub QC Sa Đéc) → Chốt 2 (Shop TP.HCM).' },
  { id: 'KW-25', intent: 'INFORMATIONAL_AEO', keyword: 'Cơ chế đặt cọc VietQR Escrow trong nông sản hoa kiểng', audience: 'Chủ vườn, chủ shop & chuyên gia chuỗi cung ứng', targetRoute: '/docs.md', conversionHook: 'Bảo chứng hai chiều: Nhà vườn chắc tiền, chủ shop chắc quy cách, sàn ứng vốn 0 đồng.' },
  { id: 'KW-26', intent: 'INFORMATIONAL_AEO', keyword: 'Cách xử lý khi nhà vườn giao hoa nở sớm dịp Tết', audience: 'Người mua sỉ tìm phương án phòng ngừa rủi ro', targetRoute: '/discover (FAQPage)', conversionHook: 'Quy trình từ chối nghiệm thu tại Chốt 1/Chốt 2 và kích hoạt hoàn cọc 100% trong ngày.' },
  { id: 'KW-27', intent: 'INFORMATIONAL_AEO', keyword: 'Kích thước chuẩn chậu cúc mâm xôi Hạng A Sa Đéc', audience: 'Người mua sỉ lập tiêu chuẩn đầu vào', targetRoute: '/api/public/catalog', conversionHook: 'Thông số chuẩn: Đường kính chậu 28–32cm, cao 50–60cm, đường kính tán 80–100cm.' },
  { id: 'KW-28', intent: 'INFORMATIONAL_AEO', keyword: 'Lịch cắt giao hoa Tết làng hoa Sa Đéc hàng năm', audience: 'Các vựa hoa lên lịch điều phối bến bãi', targetRoute: '/discover?mode=SEASONAL_PREORDER', conversionHook: 'Lịch xuất bến chi tiết từ 15 tháng Chạp đến 27 tháng Chạp theo từng dòng hoa.' },
  { id: 'KW-29', intent: 'INFORMATIONAL_AEO', keyword: 'Truy xuất nguồn gốc hoa kiểng bằng mã QR niêm phong', audience: 'Chuỗi cửa hàng hoa & khách hàng B2B', targetRoute: '/api/schema (verifyQrToken)', conversionHook: 'Xác thực chữ ký lô hàng và lịch sử kiểm định chống tráo hàng Hạng A xuống Hạng C.' },
  { id: 'KW-30', intent: 'INFORMATIONAL_AEO', keyword: 'Đặt sỉ hoa kiểng tự động qua AI Agent WebMCP', audience: 'Lập trình viên, trợ lý mua hàng AI doanh nghiệp', targetRoute: '/docs.md & /llms.txt', conversionHook: 'Tích hợp navigator.modelContext với 4 công cụ chuẩn tuân thủ nguyên tắc Zero Auto-Spend.' }
];

export function MarketingGtmHub(): React.ReactElement {
  const [activeTab, setActiveTab] = useState<GtmTabId>('zalo');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [personaFilter, setPersonaFilter] = useState<'ALL' | 'NURSERY' | 'SHOP'>('ALL');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = async (id: string, text: string): Promise<void> => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      // Safe fallback in headless or restricted clipboard environments
    }
    setCopiedId(id);
    setTimeout(() => {
      setCopiedId((prev) => (prev === id ? null : prev));
    }, 2500);
  };

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredZalo = ZALO_TEMPLATES.filter((item) => {
    const matchesPersona = personaFilter === 'ALL' || item.targetPersona === personaFilter;
    const matchesSearch =
      !normalizedQuery ||
      item.title.toLowerCase().includes(normalizedQuery) ||
      item.body.toLowerCase().includes(normalizedQuery) ||
      item.scenario.toLowerCase().includes(normalizedQuery);
    return matchesPersona && matchesSearch;
  });

  const filteredObjections = OBJECTION_HANDLERS.filter((item) => {
    const matchesPersona = personaFilter === 'ALL' || item.persona === personaFilter;
    const matchesSearch =
      !normalizedQuery ||
      item.objection.toLowerCase().includes(normalizedQuery) ||
      item.psychology.toLowerCase().includes(normalizedQuery) ||
      item.response.toLowerCase().includes(normalizedQuery);
    return matchesPersona && matchesSearch;
  });

  const filteredVideos = SHORT_VIDEO_SCRIPTS.filter((item) => {
    const matchesPersona =
      personaFilter === 'ALL' ||
      (personaFilter === 'NURSERY' && item.group === 'NHOM_A_NHA_VUON') ||
      (personaFilter === 'SHOP' && item.group !== 'NHOM_A_NHA_VUON');
    const matchesSearch =
      !normalizedQuery ||
      item.title.toLowerCase().includes(normalizedQuery) ||
      item.hook.toLowerCase().includes(normalizedQuery) ||
      item.bodyVisual.toLowerCase().includes(normalizedQuery) ||
      item.cta.toLowerCase().includes(normalizedQuery);
    return matchesPersona && matchesSearch;
  });

  const filteredKeywords = SEO_AEO_KEYWORDS.filter((item) => {
    const matchesSearch =
      !normalizedQuery ||
      item.keyword.toLowerCase().includes(normalizedQuery) ||
      item.audience.toLowerCase().includes(normalizedQuery) ||
      item.targetRoute.toLowerCase().includes(normalizedQuery) ||
      item.conversionHook.toLowerCase().includes(normalizedQuery);
    return matchesSearch;
  });

  return (
    <div className="bento-grid">
      {/* Header & Pilot Funnel Targets Panel */}
      <section className="panel panel--accent-border bento-full" aria-labelledby="gtm-hub-heading">
        <div className="panel__header">
          <div>
            <span className="badge badge--success">CMO &amp; FIELD SDR COMMAND CENTER</span>
            <h2 id="gtm-hub-heading" className="panel__title margin-top-12">
              🚀 Trung Tâm Tác Chiến CMO &amp; Field SDR (Sa Đéc ↔ TP.HCM)
            </h2>
            <p className="panel__subtitle">
              Bộ vũ khí tiếp cận bờ líp Tân Quy Đông, Sa Nhiên, Cai Dao và chợ đêm Hồ Thị Kỷ, Đầm Sen, Thủ Đức — Tích hợp 1-Click Copy cho điện thoại 390px.
            </p>
          </div>
          {copiedId && (
            <span className="badge badge--success" role="status" aria-live="polite">
              ✓ Đã sao chép vào bộ nhớ tạm! ({copiedId})
            </span>
          )}
        </div>

        <div className="bento-kpi-grid">
          <div className="bento-kpi-card">
            <span className="bento-kpi-card__label">MỤC TIÊU NGUỒN CUNG PILOT</span>
            <span className="bento-kpi-card__value">20–30 Nhà Vườn Sa Đéc</span>
            <span className="bento-kpi-card__meta">Tân Quy Đông, Sa Nhiên, Tân Khánh Đông</span>
          </div>
          <div className="bento-kpi-card">
            <span className="bento-kpi-card__label">MỤC TIÊU ĐẦU RA B2B</span>
            <span className="bento-kpi-card__value">30–50 Shop Hoa TP.HCM</span>
            <span className="bento-kpi-card__meta">Hồ Thị Kỷ, Đầm Sen, Thủ Đức, Quận 1–7</span>
          </div>
          <div className="bento-kpi-card">
            <span className="bento-kpi-card__label">TẦN SUẤT VẬN HÀNH</span>
            <span className="bento-kpi-card__value">100 Chuyến Hàng / Tháng</span>
            <span className="bento-kpi-card__meta">Cross-docking khung sắt ghép xe đêm</span>
          </div>
          <div className="bento-kpi-card">
            <span className="bento-kpi-card__label">CHỈ SỐ GIỮ CHÂN KHÁCH SỈ</span>
            <span className="bento-kpi-card__value">&gt; 40% Tỷ Lệ Đặt Lại</span>
            <span className="bento-kpi-card__meta">Retention Rate tuần &amp; sổ đặt trước Tết</span>
          </div>
        </div>
      </section>

      {/* Category Filter Bar */}
      <section className="panel bento-full" aria-label="Bộ lọc kho kịch bản tác chiến">
        <div className="gtm-tabs" role="tablist" aria-label="Danh mục công cụ GTM">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'zalo'}
            className={activeTab === 'zalo' ? 'btn btn--small' : 'btn btn--secondary btn--small'}
            onClick={() => setActiveTab('zalo')}
          >
            💬 4 Mẫu Zalo VietQR Escrow ({ZALO_TEMPLATES.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'objections'}
            className={activeTab === 'objections' ? 'btn btn--small' : 'btn btn--secondary btn--small'}
            onClick={() => setActiveTab('objections')}
          >
            🛡️ 10 Kịch Bản Xử Lý Từ Chối ({OBJECTION_HANDLERS.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'videos'}
            className={activeTab === 'videos' ? 'btn btn--small' : 'btn btn--secondary btn--small'}
            onClick={() => setActiveTab('videos')}
          >
            🎬 15 Kịch Bản Video TikTok/Reels ({SHORT_VIDEO_SCRIPTS.length})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'keywords'}
            className={activeTab === 'keywords' ? 'btn btn--small' : 'btn btn--secondary btn--small'}
            onClick={() => setActiveTab('keywords')}
          >
            🔍 30 Từ Khóa SEO / AEO / GEO ({SEO_AEO_KEYWORDS.length})
          </button>
        </div>

        <div className="grid grid--two">
          <label className="field field--grow">
            <span className="field__label">Tìm kiếm nhanh kịch bản / từ khóa / địa bàn</span>
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Nhập từ khóa: cúc mâm xôi, VietQR, Hồ Thị Kỷ, ép giá, hoàn cọc..."
            />
          </label>
          <label className="field field--grow">
            <span className="field__label">Lọc theo đối tượng tiếp cận (Persona)</span>
            <select
              value={personaFilter}
              onChange={(e) => setPersonaFilter(e.target.value as 'ALL' | 'NURSERY' | 'SHOP')}
            >
              <option value="ALL">Tất cả đối tượng (Nhà vườn Sa Đéc &amp; Chủ shop TP.HCM)</option>
              <option value="NURSERY">🌱 Nhà vườn Sa Đéc (Tân Quy Đông, Sa Nhiên, Tân Khánh Đông)</option>
              <option value="SHOP">🏪 Chủ shop / Vựa hoa TP.HCM (Hồ Thị Kỷ, Đầm Sen, Thủ Đức)</option>
            </select>
          </label>
        </div>
      </section>

      {/* TAB 1: 4 Zalo VietQR Escrow Templates */}
      {activeTab === 'zalo' &&
        filteredZalo.map((tpl) => {
          const isCopied = copiedId === tpl.id;
          return (
            <article key={tpl.id} className="copy-card bento-half">
              <div>
                <div className="copy-card__header">
                  <h3 className="copy-card__title">{tpl.title}</h3>
                  <span className={tpl.targetPersona === 'NURSERY' ? 'badge badge--warning' : 'badge badge--info'}>
                    {tpl.channel}
                  </span>
                </div>
                <p className="panel__subtitle margin-bottom-8">{tpl.scenario}</p>
                <pre className="copy-card__body">{tpl.body}</pre>
              </div>
              <div className="copy-card__footer">
                <span className="code-chip">{tpl.id}</span>
                <button
                  type="button"
                  className={isCopied ? 'btn btn--small' : 'btn btn--secondary btn--small'}
                  onClick={() => void handleCopy(tpl.id, tpl.body)}
                >
                  {isCopied ? '✓ Đã sao chép vào bộ nhớ tạm!' : '📋 Sao chép mẫu Zalo'}
                </button>
              </div>
            </article>
          );
        })}

      {/* TAB 2: 10 Objection Handlers */}
      {activeTab === 'objections' &&
        filteredObjections.map((obj) => {
          const isCopied = copiedId === obj.id;
          return (
            <article key={obj.id} className="copy-card bento-half">
              <div>
                <div className="copy-card__header">
                  <span className={obj.persona === 'NURSERY' ? 'badge badge--warning' : 'badge badge--info'}>
                    {obj.persona === 'NURSERY' ? '🌱 Nhà Vườn Sa Đéc' : '🏪 Chủ Shop / Vựa TP.HCM'}
                  </span>
                  <span className="code-chip">{obj.id}</span>
                </div>
                <h3 className="copy-card__title margin-top-12">&ldquo;{obj.objection}&rdquo;</h3>
                <p className="panel__subtitle margin-bottom-8">
                  <strong>Tâm lý thật:</strong> {obj.psychology}
                </p>
                <pre className="copy-card__body">{obj.response}</pre>
              </div>
              <div className="copy-card__footer">
                <span className="badge badge--success">Kịch bản hóa giải chuẩn SDR</span>
                <button
                  type="button"
                  className={isCopied ? 'btn btn--small' : 'btn btn--secondary btn--small'}
                  onClick={() => void handleCopy(obj.id, obj.response)}
                >
                  {isCopied ? '✓ Đã sao chép vào bộ nhớ tạm!' : '📋 Sao chép lời thoại hóa giải'}
                </button>
              </div>
            </article>
          );
        })}

      {/* TAB 3: 15 Short Video Scripts */}
      {activeTab === 'videos' &&
        filteredVideos.map((vid) => {
          const fullScriptText = `${vid.title} (${vid.duration})\n• Hook (0-3s): ${vid.hook}\n• Cảnh quay & Hành động: ${vid.bodyVisual}\n• CTA: ${vid.cta}`;
          const isCopied = copiedId === vid.id;
          return (
            <article key={vid.id} className="copy-card bento-half">
              <div>
                <div className="copy-card__header">
                  <span className="badge badge--info">{vid.groupLabel}</span>
                  <span className="badge badge--mono">{vid.duration}</span>
                </div>
                <h3 className="copy-card__title margin-top-12">{vid.title}</h3>
                <div className="copy-card__body margin-top-12">
                  <p className="margin-0 margin-bottom-8">
                    <strong>🔥 Hook (0s–3s):</strong> {vid.hook}
                  </p>
                  <p className="margin-0 margin-bottom-8">
                    <strong>🎥 Visual &amp; Action:</strong> {vid.bodyVisual}
                  </p>
                  <p className="margin-0">
                    <strong>👉 CTA Chốt:</strong> {vid.cta}
                  </p>
                </div>
              </div>
              <div className="copy-card__footer">
                <span className="code-chip">{vid.id}</span>
                <button
                  type="button"
                  className={isCopied ? 'btn btn--small' : 'btn btn--secondary btn--small'}
                  onClick={() => void handleCopy(vid.id, fullScriptText)}
                >
                  {isCopied ? '✓ Đã sao chép vào bộ nhớ tạm!' : '📋 Sao chép kịch bản quay'}
                </button>
              </div>
            </article>
          );
        })}

      {/* TAB 4: 30 SEO / AEO / GEO Keywords */}
      {activeTab === 'keywords' && (
        <section className="panel bento-full" aria-label="Ma trận 30 từ khóa B2B SEO AEO GEO">
          <div className="panel__header">
            <div>
              <h3 className="panel__title">Ma Trận 30 Từ Khóa B2B Theo Search Intent &amp; Citation-First AEO</h3>
              <p className="panel__subtitle">
                Đồng bộ 100% giữa bài viết SEO, Schema.org JSON-LD (WholesaleStore + OfferCatalog + FAQPage) và /llms-full.txt.
              </p>
            </div>
            <span className="badge badge--success">{filteredKeywords.length} / 30 từ khóa</span>
          </div>

          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Mã</th>
                  <th>Nhóm Intent</th>
                  <th>Từ khóa mục tiêu (Keyword)</th>
                  <th>Đối tượng tìm kiếm</th>
                  <th>Điểm chạm đích</th>
                  <th>Thông điệp chuyển đổi (Hook)</th>
                  <th>Sao chép</th>
                </tr>
              </thead>
              <tbody>
                {filteredKeywords.map((kw) => {
                  const isCopied = copiedId === kw.id;
                  const copyPayload = `${kw.keyword} — ${kw.conversionHook} (${kw.targetRoute})`;
                  return (
                    <tr key={kw.id}>
                      <td>
                        <span className="code-chip">{kw.id}</span>
                      </td>
                      <td>
                        <span
                          className={
                            kw.intent === 'TRANSACTIONAL'
                              ? 'badge badge--success'
                              : kw.intent === 'COMMERCIAL'
                                ? 'badge badge--info'
                                : 'badge badge--warning'
                          }
                        >
                          {kw.intent}
                        </span>
                      </td>
                      <td className="text-bold">{kw.keyword}</td>
                      <td>{kw.audience}</td>
                      <td>
                        <span className="code-chip">{kw.targetRoute}</span>
                      </td>
                      <td>{kw.conversionHook}</td>
                      <td>
                        <button
                          type="button"
                          className={isCopied ? 'btn btn--small' : 'btn btn--secondary btn--small'}
                          onClick={() => void handleCopy(kw.id, copyPayload)}
                        >
                          {isCopied ? '✓ Đã sao chép vào bộ nhớ tạm!' : '📋 Copy'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
