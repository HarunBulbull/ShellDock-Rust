# Windows doğrulaması — 15 Kasım 2026

Yerel makine: Windows x64 (10.0.26300), Rust MSVC 1.100.0, Visual Studio Build Tools 2022 / MSVC 14.44, Windows SDK 10.0.26100.0. Uygulama sürümü: 0.1.0 geliştirme önizlemesi.

| Kontrol | Sonuç |
|---|---|
| TypeScript + Vite üretim derlemesi | Geçti |
| Playwright / Chromium, taklit IPC | 2 test geçti |
| Rust testleri | 6 test geçti |
| Clippy `--all-targets -- -D warnings` | Geçti |
| Rustfmt / Prettier | Geçti |
| Optimize Windows x64 uygulaması | Derlendi |
| NSIS x64 kurulumu | Üretildi, 3.27 MiB |
| Gerçek `.exe`: WebView2 açılışı, Rust IPC, bağlantı formu | Geçti |
| PE bağımlılık kontrolü | Ayrı OpenSSL / libssh2 DLL bağımlılığı yok |

Protokol testi geçici loopback SSH/SFTP sunucusunda Ed25519 host anahtarı, parola girişi, şifreli RSA özel anahtarı, OpenSSH Ed25519 özel anahtarı, yanlış parola/passphrase reddi, PTY açma/boyutlandırma, terminal çıktısı, Unicode dosya roundtrip, hedef çatışması, rename/delete ve yanlış host fingerprint reddini kapsar. Credential testi yalnızca rastgele UUID ile oluşturduğu geçici Windows Credential Manager girdisini yazar/okur/siler.

Masaüstü testi sunucu kaydı oluşturmaz; gerçek Rust `list_connections` komutunu çağırır ve bağlantı formunu açıp kapatır. Ekran görüntüsü: [windows-native.png](screenshots/windows-native.png).

## Yerel çıktılar

| Dosya | Boyut | SHA-256 |
|---|---|---|
| `src-tauri/target/release/shelldock.exe` | 13,330,432 byte | `97F9DC99DC3C30B09F31A73606B22096589B6FD045FECBCC9379E2BA9CE8D534` |
| `src-tauri/target/release/bundle/nsis/ShellDock_0.1.0_x64-setup.exe` | 3,423,721 byte | `AC01B20AFC3CC4744F0181CD07C087201E5D5826DC2BD6EF979B58C7B3C70B6B` |

Çıktılar Git'e dahil edilmez; [v0.1.0 sürümüne](https://github.com/HarunBulbull/ShellDock-Rust/releases/tag/v0.1.0) eklenir. Bu hash'ler ilk yerel çıktılara aittir; sonraki derlemelerde değişebilir. Uygulama ve kurulum kod imzalı değildir. Kurulum/kaldırma sihirbazı henüz uçtan uca denenmedi. Bu kayıt yerel test sonuçlarını anlatır; güncel uzak CI sonuçları [Windows checks](https://github.com/HarunBulbull/ShellDock-Rust/actions/workflows/windows.yml) sayfasındadır.

Tam özellik eşitliği, üretim sunucuları, vim/tmux, uzun oturum/kesinti, SSH agent, klasör transferi, senkronizasyon ve iptal/devam senaryoları bu doğrulamanın kapsamında değildir. Ayrıntılar: [PARITY.md](PARITY.md).

## Bu aşamada giderilen sorunlar

- Varsayılan Windows WinCNG arka ucundaki özel anahtar/modern algoritma kısıtları nedeniyle statik OpenSSL arka ucuna geçildi.
- Test sunucusunun desteklemediği DH group exchange ilanı kaldırıldı; modern ve uygulanan key exchange yöntemleriyle test edilir.
- Vite'nin kilitli Rust PDB dosyalarını izlemesi engellendi.
- Vendored OpenSSL'in dağıtmadığı PDB dosyalarına ait LNK4099 mesajı hedefli olarak susturuldu; uygulamanın Rust debug sembolleri korunur.
- Rust/Perl bulma, checksum doğrulamalı taşınabilir Perl kurulumu ve gerçek masaüstü açılış testi eklendi.
