# Lounge Finder V37 — bản Web công khai

V37 được thiết kế để chạy trên một máy chủ web. Người sử dụng cuối chỉ cần mở URL bằng Chrome/Edge/Safari; không cần CMD, Node.js hay cài đặt gì trên máy.

## Cam kết luồng tra cứu V37
- Một lượt tra cứu có ngân sách tối đa 55 giây ở server và 59 giây ở trình duyệt.
- Kết quả thành công chỉ được trả khi dữ liệu EN và VI đều đã sẵn sàng.
- VI và EN là hai chế độ hiển thị riêng; chuyển ngôn ngữ không gọi lại LoungeKey và không dịch lại.
- Dữ liệu đã cache trả nhanh hơn đáng kể.
- Nếu nguồn hoặc dịch không hoàn tất trong giới hạn, web báo lỗi để thử lại thay vì trả tiếng Anh vào chế độ VI.

## Đưa lên Internet (không cần CMD cho người dùng)
1. Đưa toàn bộ thư mục này lên một Git repository.
2. Tạo một Web Service Node.js trên nhà cung cấp hosting và trỏ vào repository.
3. Build command: `npm ci`
4. Start command: `npm start`
5. Health check: `/api/health`
6. Sau khi deploy, gửi URL HTTPS cho người dùng. Họ chỉ mở link và sử dụng.

File `render.yaml` đã được thêm để hỗ trợ triển khai kiểu Blueprint trên Render.

## Lưu ý kiến trúc
Đây không thể là một file HTML tĩnh duy nhất vì Lounge Finder cần server để gọi nguồn LoungeKey, lưu cache SQLite và dịch EN→VI. V37 đóng gói cả frontend + backend thành một website duy nhất; CMD chỉ còn cần cho phát triển local, không cần cho người dùng sau khi website được deploy.
