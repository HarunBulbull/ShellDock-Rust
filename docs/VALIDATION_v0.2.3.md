# Windows v0.2.3 doğrulaması

- TypeScript/Vite üretim derlemesi (`tsc -b && vite build`), 12 Rust testi (`cargo test`), 14 Chromium/Playwright arayüz testi, `cargo fmt --check` ve `cargo clippy --all-targets -- -D warnings` geçti.
- Rust testleri yerel klasör oluşturma/üzerine yazmayan kopyalama, Windows Credential Manager yazma/okuma/silme, host anahtarı değişikliğinde bağlantı reddi, SFTP özyinelemeli toplu silme, uzak dosya yazmada `mtime` çakışma tespiti, 2.200+ öğeli klasör ağacı + >2 MB akışlı `files::run_batch` indirmesi ve Windows Shell `IDropTarget` + MTA `IDataObjectAsyncCapability` asenkron bırakma testini loopback SFTP sunucusuyla doğrular.
- Playwright arayüz testleri kenar çubuğundaki 6×6 px yeşil nokta boyutunu, pencere kenarından dışa sürükleme tetiklemesinde `start_external_drag` çağrısını (`roots` ipuçlarıyla) ve `external-drag-error` bildirimini doğrular.

## Test sınırları

- SSH/SFTP protokol testleri `127.0.0.1` loopback fixture sunucusuyla koşulmuştur; üretim OpenSSH sunucusu, Windows OpenSSH SSH agent, ağ kesintisi ve NSIS kurulum/kaldırma sihirbazı ayrıca doğrulanmalıdır.
- Uzak panelden fiziksel Windows Explorer / Masaüstü penceresine fareyle sürükle-bırak, Windows Shell `IDropTarget` üzerinden otomatik test edilmiş olup canlı masaüstü penceresinde manuel olarak da doğrulanmalıdır.
- Üretim NSIS ve taşınabilir ZIP paketlemesi `v0.2.3` etiketiyle tetiklenen GitHub Actions `Release Windows` akışında çalıştırılır.
