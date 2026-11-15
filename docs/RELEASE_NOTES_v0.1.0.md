# ShellDock for Windows v0.1.0 — Preview

ShellDock'un Tauri 2, React ve Rust ile geliştirilen ilk Windows x64 önizlemesi.

## İndir ve çalıştır

- **ShellDock_0.1.0_x64-setup.exe**: Windows kurulum paketi.
- **ShellDock_0.1.0_windows-x64.zip**: `ShellDock.exe` ve lisansları içeren taşınabilir paket. ZIP'i çıkarıp uygulamayı açın.
- **ShellDock_0.1.0_windows-x64.exe**: Doğrudan çalıştırılabilir uygulama.
- **SHA256SUMS.txt**: Bu sürümün dosyalarını doğrulamak için SHA-256 değerleri.

Windows 10/11 x64 ve WebView2 Runtime gerekir. Hazır uygulama için Rust, Node.js, Perl veya Visual Studio gerekmez. Paketler kod imzalı değildir.

## Bu sürümde

- Kayıtlı sunucular, gruplar, favoriler, notlar ve arama.
- Sekmeli SSH terminali, terminal araması ve PTY boyutlandırma.
- Parola ve özel anahtar kimlik doğrulaması; Ed25519 ve şifreli RSA anahtar desteği.
- Açık host anahtarı doğrulaması ve Windows Credential Manager entegrasyonu.
- SFTP gezinme, dosya yükleme/indirme ve byte ilerlemesi.
- Klasör oluşturma, rename, dosya/boş klasör silme ve UTF-8 metin düzenleme.

## Doğrulama

Yerelde 6 Rust testi, 2 Chromium arayüz testi, Clippy ve gerçek Windows `.exe` üzerinde WebView2/Rust IPC açılış testi geçti. SSH/SFTP protokol testi geçici bir loopback sunucusu kullanır; üretim sunucusu veya uzun oturum garantisi değildir. [Ayrıntılı doğrulama kaydı](https://github.com/HarunBulbull/ShellDock-Rust/blob/v0.1.0/docs/VALIDATION.md).

## Bilinen sınırlar

Bu sürüm orijinal macOS uygulamasıyla henüz tam özellik eşitliğinde değildir. Klasör transferi, kuyruk/duraklatma/devam, çift dosya paneli, senkronizasyon ve Explorer entegrasyonu henüz yoktur. Transfer hatasında kısmi hedef dosya kalabilir. Uzak metin düzenleyicisi atomik kayıt veya çatışma algılama yapmaz. SSH agent uyumluluğu ve kurulum/kaldırma sihirbazı ayrıca uçtan uca doğrulanmadı.

[Özellik eşitliği planı](https://github.com/HarunBulbull/ShellDock-Rust/blob/v0.1.0/docs/PARITY.md) · [Orijinal macOS projesi](https://github.com/HarunBulbull/ShellDock)
