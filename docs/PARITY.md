# macOS → Windows özellik eşitliği

Kaynak incelemesi: `HarunBulbull/ShellDock`, bu çalışma sırasında `.reference/ShellDock` altında salt referans kopyası. Bu klasör Git'e dahil edilmez.

İncelenen kaynak commit: `acce1c24e8c88d858f2efb3942487e9846eff856`.

**Kodlandı** ifadesi her iş akışının uçtan uca doğrulandığı anlamına gelmez. v0.2.3’te 12 Rust ve 14 arayüz testi geçti; aşağıda doğrulanan ve bekleyen işler ayrıdır.

| Kaynak işlev                              | Windows durumu                                                                                                                 | Sonraki doğrulama / iş                            |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Sunucu CRUD, grup, arama, favori          | Kodlandı                                                                                                                       | Kalıcılığı masaüstünde dene                       |
| Parola / private key                      | Loopback testi geçti; şifreli RSA ve Ed25519 dahil                                                                             | OpenSSH üretim benzeri sunucularda dene           |
| SSH agent                                 | Kodlandı                                                                                                                       | Windows OpenSSH agent uyumluluğu                  |
| Host anahtarı güven kararı                | UI ve değişen anahtar Rust testi geçti                                                                                         | Gerçek sunucu anahtarı değişimi senaryosu         |
| Keychain karşılığı                        | Windows Credential Manager yazma/okuma/silme testi geçti                                                                       | Uygulama UI'sinden credential yaşam döngüsü       |
| Çoklu SSH sekmeleri                       | Kodlandı, UI testi geçti                                                                                                       | Çoklu gerçek sunucu testi                         |
| Çoklu pencere / sekme ayırma              | Planlandı                                                                                                                      | Tauri pencere ve oturum sahipliği                 |
| Terminal araması                          | Kodlandı                                                                                                                       | Unicode ve uzun scrollback                        |
| Terminal tema / yazı / sağ tık tercihleri | Planlandı                                                                                                                      | Tercih deposu ve UI                               |
| SFTP gezinme                              | v0.2.2: `PooledSftp` havuzu ve özyinelemeli toplu silme eklendi                                                                | Büyük dizin ve bağlantı kesintisi                 |
| Klasör oluştur / yeniden adlandır / sil   | v0.2.2: yeni dosya, çoklu toplu silme ve `chmod` eklendi                                                                       | Yetki kenar durumları                             |
| Uzak metin düzenleme                      | v0.2.2: CodeMirror 6 sekmeli/split editör, `.part` kayıt, `mtime` çakışma kontrolü, harici izleyici                            | Harici uygulama otomasyonu                        |
| Dosya yükle / indir                       | Çoklu seçim ve rekürsif klasör transferi doğrulandı                                                                            | Büyük dosya, disk doluluğu, bağlantı kesintisi    |
| Dosya ilerlemesi                          | Byte ve hız göstergesi kodlandı                                                                                                | Çok büyük dosyalarda profil çıkarma               |
| Dosya / klasör çoğaltma                   | v0.2.2: `duplicate` ve yerel `copy` eklendi                                                                                    | Uzaktan büyüğe çoğaltma                           |
| Klasör transfer / merge / conflict policy | v0.2.0: iç içe ve boş klasörler, Skip/Replace, staging ve rollback test edildi                                                 | Büyük ağaçlar ve kesintiler                       |
| Kuyruk / pause / resume / cancel / retry  | Oturum içi sıra ve iptal var; sekme değişiminde korunur                                                                        | Kalıcı kuyruk, pause/resume/retry                 |
| Yerel + uzak çift panel                   | v0.2.2: sürücü/kısayol seçici, sütun sıralama, Geri/İleri ve sağ tık menüleri                                                  | Ek tercih kalıcılığı                              |
| Explorer sürükle-bırak                    | v0.2.3: çift yönlü pointer sürükleme, Explorer→Local kopya, Remote→Explorer asenkron MTA `SHDoDragDrop` ve sınırsız ağaç akışı | Fiziksel fareyle Explorer dışı sürükleme denemesi |
| SFTP keepalive / otomatik reconnect       | v0.2.2: oturum başına `PooledSftp` ve hata yenileme                                                                            | Uzun süreli bağlantı düşmeleri                    |
| Uzak recursive search / favori yollar     | Planlandı                                                                                                                      | Bütçeli tarama ve yol deposu                      |
| Karşılaştırma / senkronizasyon            | Planlandı                                                                                                                      | Önizlemeli, açık onaylı senkronizasyon planı      |
| SHA-256 dosya doğrulama                   | Planlandı                                                                                                                      | Büyük dosyada streaming hash                      |
| Sunucular arası kopya                     | Planlandı                                                                                                                      | Kota ve temizlik kontrollü geçici staging         |
| Finder Services / Dock karşılığı          | Planlandı                                                                                                                      | Explorer bağlam menüsü / dosya açma ilişkileri    |
| Anonim tanı raporu                        | Planlandı                                                                                                                      | Kimlik, yol, çıktı, sır içermeyen rapor           |
| Oturum restorasyonu                       | Planlandı                                                                                                                      | Sürümlemeli workspace şeması                      |

Öncelik: büyük dosya/kesinti testleri → kalıcı kuyruk ve devam → senkronizasyon → dışa sürükleme ve Explorer bağlam menüsü entegrasyonu. Yerel/uzak çift panel ve ilk toplu klasör transferi akışı tamamlandı.

Yerel dosya silme/yeniden adlandırma, Delete/F2 ve harfle seçim v0.2.1’de eklendi. Yerel sürükleme pointer hareketleriyle test edilir. Üzerine yazma sonrası indirilen içerik yeniden karşılaştırılır; yanlış veri döndüren fixture sunucusu başarı yerine hata üretir.
