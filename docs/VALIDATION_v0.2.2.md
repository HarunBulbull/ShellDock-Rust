# Windows v0.2.2 doğrulaması

- TypeScript/Vite üretim derlemesi (`tsc -b && vite build`), 10 Rust testi (`cargo test`), 13 Chromium/Playwright arayüz testi ve `cargo clippy --all-targets -- -D warnings` geçti.
- Rust testleri yerel klasör oluşturma/üzerine yazmayan kopyalama, Windows Credential Manager yazma/okuma/silme, host anahtarı değişikliğinde bağlantı reddi, SFTP özyinelemeli toplu silme ve uzak dosya yazmada `mtime` çakışma tespitini loopback SFTP sunucusuyla doğrular.
- `scripts/smoke-files.cjs` yalıtılmış `com.harunbulbul.shelldock.smoke.*` WebView2 profili üzerinden yerel → uzak yüklemeyi, Replace sonrası bayt doğrulamayı, uzak → yerel pointer sürüklemesini, uzak metin dosyasını editörde açıp `Ctrl+S` ile kaydetmeyi ve özyinelemeli toplu uzak silmeyi gerçek WebView2 + Rust IPC ile doğrular. (Son doğrulamada bu koşudan hemen sonra yalnızca `scripts/test-server.cjs` üzerinde Prettier boşluk biçimlendirmesi ve nihai production `tauri build` yapılmıştır.)
- Temiz production paketi `npm.cmd run tauri build` ile üretildi (`shelldock.exe` ve `ShellDock_0.2.2_x64-setup.exe`).

## Test sınırları

- `npm.cmd run test:desktop` (`scripts/smoke-desktop.cjs`), test anında makinede `com.harunbulbul.shelldock` profilini kullanan çalışan bir v0.2.0 örneği açık olduğu için çalıştırılmadı.
- Uzak panelden fiziksel Windows Explorer / Masaüstü penceresine sürükleyip bırakma (`start_external_drag` OLE `DoDragDrop`), `cargo clippy` ve release derlemesinden geçmiştir; dış pencere hedefi olduğundan fiziksel Explorer penceresine sürükleme masaüstünde manuel denenmelidir.
- SSH/SFTP protokol testleri `127.0.0.1` loopback fixture sunucusuyla koşulmuştur; üretim OpenSSH sunucusu, Windows OpenSSH SSH agent, çok büyük dosya (>2 MB), ağ kesintisi ve NSIS kurulum/kaldırma sihirbazı ayrıca doğrulanmalıdır.
