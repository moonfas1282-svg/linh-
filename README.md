# RunPulse Android

Ứng dụng chạy bộ Android dùng Expo/React Native.

## Tính năng
- Theo dõi GPS nền bằng foreground service.
- Quãng đường, thời gian, pace, tốc độ.
- Active calories tính theo MET của tốc độ đã làm mượt ở từng đoạn GPS.
- Cadence/số bước từ cảm biến điện thoại khi app đang hiển thị.
- Lưu offline với AsyncStorage.
- Đồng bộ từng buổi chạy lên Google Apps Script/Google Sheet.
- Lịch sử và tổng hợp trong ngày.

## Cấu hình đã nhúng
- Google Apps Script URL: xem `src/config.ts`
- API key: xem `src/config.ts`

## Build
```bash
npm install
npx expo prebuild --platform android
cd android
./gradlew assembleRelease
```
