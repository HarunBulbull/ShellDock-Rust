# macOS → Windows özellik eşitliği

Kaynak incelemesi: `HarunBulbull/ShellDock`, bu çalışma sırasında `.reference/ShellDock` altında salt referans kopyası. Bu klasör Git'e dahil edilmez.

İncelenen kaynak commit: `acce1c24e8c88d858f2efb3942487e9846eff856`.

**Kodlandı** ifadesi her iş akışının uçtan uca doğrulandığı anlamına gelmez. v0.2.0'da sekiz Rust, yedi arayüz testi ve yalıtılmış gerçek Windows dosya akışı testi geçti; aşağıda doğrulanan ve bekleyen işler ayrıdır.

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
| Dosya yükle / indir | Çoklu seçim ve rekürsif klasör transferi doğrulandı | Büyük dosya, disk doluluğu, bağlantı kesintisi |
| Dosya ilerlemesi | Byte düzeyinde kodlandı | Performans ve hız hesabı |
| Dosya / klasör çoğaltma | Planlandı | İşlem altyapısı |
| Klasör transfer / merge / conflict policy | v0.2.0: iç içe ve boş klasörler, Skip/Replace, staging ve rollback test edildi | Büyük ağaçlar ve kesintiler |
| Kuyruk / pause / resume / cancel / retry | Oturum içi sıra ve iptal var; sekme değişiminde korunur | Kalıcı kuyruk, pause/resume/retry |
| Yerel + uzak çift panel | v0.2.0: Remote/Local/Both, çoklu seçim, yerel gezinme | Sürücü/favori kısayolları, tercihlerin genişletilmesi |
| Explorer sürükle-bırak | Çoklu native drop olayı ve yerel panelden uzak klasöre sürükleme test edildi | Fiziksel Explorer fare testi ve Explorer'a dışa sürükleme |
| SFTP keepalive / otomatik reconnect | Kısmi | SSH keepalive var; SFTP her işte yeniden bağlanır |
| Uzak recursive search / favori yollar | Planlandı | Bütçeli tarama ve yol deposu |
| Karşılaştırma / senkronizasyon | Planlandı | Önizlemeli, açık onaylı senkronizasyon planı |
| SHA-256 dosya doğrulama | Planlandı | Büyük dosyada streaming hash |
| Sunucular arası kopya | Planlandı | Kota ve temizlik kontrollü geçici staging |
| Finder Services / Dock karşılığı | Planlandı | Explorer bağlam menüsü / dosya açma ilişkileri |
| Anonim tanı raporu | Planlandı | Kimlik, yol, çıktı, sır içermeyen rapor |
| Oturum restorasyonu | Planlandı | Sürümlemeli workspace şeması |

Öncelik: büyük dosya/kesinti testleri → kalıcı kuyruk ve devam → senkronizasyon → dışa sürükleme ve Explorer bağlam menüsü entegrasyonu. Yerel/uzak çift panel ve ilk toplu klasör transferi akışı tamamlandı.
