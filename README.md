# Lounge Finder V37

Bản V37: kết quả thành công có sẵn đồng thời dữ liệu VI và EN, thời gian tương tác giới hạn dưới 1 phút. Có cấu hình triển khai web để người dùng cuối chỉ cần mở URL, không chạy CMD.

# Lounge Finder V36

V36 sửa phần song ngữ và tốc độ dịch:

- Mặc định hiển thị **VI + EN** song song. Có thể chuyển riêng VI hoặc EN.
- Ở chế độ VI, nội dung chưa dịch sẽ hiển thị “Đang dịch sang tiếng Việt…” thay vì giả vờ dùng tiếng Anh.
- Dịch cả sân bay theo lô, không dịch tuần tự từng lounge.
- Kết quả tiếng Anh hiển thị ngay; bản dịch VI chạy nền và giao diện tự cập nhật.
- Cache VI cũ thiếu section sẽ tự được phát hiện và sửa.
- Giữ filter Terminal, link chi tiết, hình ảnh và cache tốc độ cao.

## Chạy trên Windows
1. Tắt bản cũ bằng STOP_LOUNGE_FINDER.vbs.
2. Mở OPEN_LOUNGE_FINDER.vbs.
3. Nếu trình duyệt còn giao diện cũ, nhấn Ctrl+F5 một lần.

Lưu ý: lần đầu với sân bay chưa có bản dịch VI có thể cần vài giây để hoàn tất dịch nền; EN vẫn dùng được ngay.


## V36
- Chỉ còn 2 chế độ ngôn ngữ: VI và EN.
- VI là mặc định.
- Tra cứu tương tác có ngân sách tối đa dưới 1 phút: HTTP sync tối đa 38 giây + chờ dịch VI tối đa 15 giây; không chờ Playwright trong request.
- Nếu nguồn LoungeKey chưa phản hồi kịp, trả thông báo trong 1 phút và tiếp tục cập nhật nền cho lần tra sau.
- Cache đã có dữ liệu trả gần như ngay lập tức.
