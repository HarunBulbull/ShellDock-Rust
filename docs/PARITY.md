# macOS → Windows özellik eşitliği

Kaynak incelemesi: `HarunBulbull/ShellDock`, bu çalışma sırasında `.reference/ShellDock` altında salt referans kopyası. Bu klasör Git'e dahil edilmez.

İncelenen kaynak commit: `acce1c24e8c88d858f2efb3942487e9846eff856`.

**Kodlandı** ifadesi her iş akışının uçtan uca doğrulandığı anlamına gelmez. Windows Rust derlemesi ve altı test geçti; aşağıda doğrulanan ve bekleyen işler ayrıdır.

| Kaynak işlev | Windows durumu | Sonraki doğrulama / iş |
|---|---|---|
| Sunucu CRUD, grup, arama, favori | Kodlandı | Kalıcılığı masaüstünde dene |
| Parola / private key | Loopback testi geçti; şifreli RSA ve Ed25519 dahil | OpenSSH üretim benzeri sunucularda dene |
| SSH agent | Kodlandı | Windows OpenSSH agent uyumluluğu |
| Host anahtarı güven kararı | UI ve değişen anahtar Rust testi geçti | Gerçek sunucu anahtarı değişimi senaryosu |
| Keychain karşılığı | Windows Credential Manager yazma/okuma/silme testi geçti | Uygulama UI'sinden credential yaşam döngüsü |
| Çoklu SSH sekmeleri | Kodlandı, UI testi geçti | Çoklu gerçek sunucu testi |
| Çoklu pencere / sekme ayırma | Planlandı | Tauri pencere ve oturum sahipliği |
| Terminal araması | Kodlandı | Unicode ve uzun scrollback |
| Terminal tema / yazı / sağ tık tercihleri | Planlandı | Tercih deposu ve UI |
| SFTP gezinme | Kodlandı | Büyük dizin ve bağlantı kesintisi |
| Klasör oluştur / yeniden adlandır / sil | Kodlandı | Yetki ve boş olmayan klasör hataları |
| Uzak metin düzenleme | İlk sürüm kodlandı | Atomik kayıt ve çatışma algılama |
| Dosya yükle / indir | İlk sürüm kodlandı | Büyük dosya ve disk doluluğu |
| Dosya ilerlemesi | Byte düzeyinde kodlandı | Performans ve hız hesabı |
| Dosya / klasör çoğaltma | Planlandı | İşlem altyapısı |
| Klasör transfer / merge / conflict policy | Planlandı | Rekürsif planlayıcı ve symlink kuralları |
| Kuyruk / pause / resume / cancel / retry | Planlandı | Kalıcı iş modeli, iptal tokenları |
| Yerel + uzak çift panel | Planlandı | Windows dosya sistemi tarayıcısı |
| Explorer sürükle-bırak | Planlandı | Tauri dosya bırakma ve dışa sürükleme |
| SFTP keepalive / otomatik reconnect | Kısmi | SSH keepalive var; SFTP her işte yeniden bağlanır |
| Uzak recursive search / favori yollar | Planlandı | Bütçeli tarama ve yol deposu |
| Karşılaştırma / senkronizasyon | Planlandı | Önizlemeli, açık onaylı senkronizasyon planı |
| SHA-256 dosya doğrulama | Planlandı | Büyük dosyada streaming hash |
| Sunucular arası kopya | Planlandı | Kota ve temizlik kontrollü geçici staging |
| Finder Services / Dock karşılığı | Planlandı | Explorer bağlam menüsü / dosya açma ilişkileri |
| Anonim tanı raporu | Planlandı | Kimlik, yol, çıktı, sır içermeyen rapor |
| Oturum restorasyonu | Planlandı | Sürümlemeli workspace şeması |

Öncelik: Windows uygulama/paket doğrulaması → güvenilir transfer kuyruğu → klasör / çift panel / senkronizasyon → Explorer entegrasyonu ve dağıtım. İlk yerel Rust derlemesi, loopback protokol ve credential testleri tamamlandı.
