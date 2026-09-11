# Lounge Finder V41

V41 tối ưu cho bản web Render: kết quả chỉ được trả khi đã có đồng thời EN + VI, với ngân sách xử lý cứng dưới 1 phút.

## Tối ưu chính
- Lấy chi tiết lounge bằng HTTP song song, không dùng Chromium trong đường tra cứu web.
- Timeout từng trang LoungeKey 7 giây; tối đa 12 request song song.
- Dịch toàn bộ sân bay theo các batch lớn song song thay vì dịch lounge-by-lounge.
- Tái sử dụng bản dịch cache và không dịch trùng các section Opening/Location/Conditions.
- Hai đợt dịch có giới hạn thời gian để phục hồi lỗi mạng tạm thời.
- API search có log thời gian từng bước: `source-sync`, `translate`, `response`.
- `/healthz` luôn trả HTTP 200 cho Render.
- Bỏ tải Chromium trong `npm ci`, giúp deploy nhanh và nhẹ hơn.

## Render
Build: `npm ci`
Start: `npm run start`
Health Check: `/healthz` hoặc `/`

## Cam kết xử lý
Server đặt deadline 57 giây; trình duyệt đặt 59,5 giây. Nếu nguồn LoungeKey hoặc dịch bên thứ ba bị lỗi hoàn toàn, hệ thống trả lỗi trong giới hạn này thay vì treo nhiều phút. Khi thành công, response có sẵn cả VI và EN.
