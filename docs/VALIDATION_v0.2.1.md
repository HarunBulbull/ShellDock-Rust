# Windows v0.2.1 doğrulaması

- TypeScript/Vite üretim derlemesi, 9 Rust testi, 9 Chromium arayüz testi ve Clippy geçti.
- Rust testleri yerel yeniden adlandırmada çakışmayı ve traversal adlarını reddetmeyi, çoklu rekürsif silmeyi ve diğer dosyaların korunmasını denetler.
- Gerçek SSH/SFTP protokol testi Skip/Replace, çoklu kökler, boş/iç içe klasörler, iptal ve rollback senaryolarını korur. Yazmayı başarılı cevaplayıp hedef okumada yanlış veri döndüren fixture, doğrulama hatası oluşturur.
- `scripts/smoke-files.cjs` yalnızca rastgele kimlikli test profilini kabul eder. Gerçek WebView2 ve Rust üzerinden dosya+klasör yükler; yerel dosyayı değiştirip tekrar Replace ile yükler; başka bir dosyayı pointer hareketleriyle uzak klasöre sürükler. Ardından çoklu indirmede iç içe dosyaları ve değiştirilen içeriği karşılaştırır.
- Aynı native testte harfle seçim, F2 ile yerel yeniden adlandırma, Delete ile çoklu dosya/klasör silme ve diskteki sonuçlar doğrulanır. Test yalnızca kendi geçici dosyalarını değiştirir.
- Native drop olayı `plugin:event|emit_to` ile `Webview/main` hedefine gönderilir. Bu, genel bir uygulama olayı göndermekten daha dar kapsamlıdır; gerçek Tauri dinleyicisi ve dosya yolları kullanılır.

## Test sınırları

Explorer’da dosya ve klasör gerçek Windows arayüzünden seçildi. Ancak Computer Use sürükleme API’si hedef koordinatın kaynak pencerenin dışında olmasını reddetti. Bu nedenle gerçek pencereler arası OLE/Explorer sürüklemesi tamamlanamadı; onun yerine native olay köprüsü test edildi. Fiziksel Explorer’dan bırakmanın çalıştığı bu kayıtla iddia edilmez. Yerel panelin kendi içindeki pointer sürüklemesi gerçek paketlenmiş uygulamada otomatik fare hareketleriyle geçti.

Test sunucusu loopback üzerinde bellekte SFTP dosyaları kullanır; üretim OpenSSH sunucusu, özel yetki düzenleri, büyük dosyalar, ağ kesilmesi ve farklı DPI/zoom kombinasyonları ayrıca denenmelidir. Uygulama yönetici olarak çalıştırılırken normal Explorer’dan sürükleme Windows tarafından engellenebilir.

Yükleme doğrulaması sunucudan tam içerik okur; ek ağ trafiği gerektirir ve kaynak/hedef dosyaları eşzamanlı değişikliklere karşı kilitlemez. Doğrulama hatası dosyanın otomatik olarak önceki sürümüne döndürüldüğü anlamına gelmez. Replace atomik değildir. Yerel silme kalıcıdır ve klasör içeriklerini de siler; onay diyaloğu gösterilir. Kurulum/kaldırma sihirbazı ayrıca test edilmedi.
