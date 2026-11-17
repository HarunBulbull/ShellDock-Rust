# ShellDock for Windows v0.2.0 — Preview

İlk Windows sürümünün arayüz ve dosya yönetimi eksiklerini gideren güncelleme.

## Değişenler

- Orijinal SwiftUI çalışma alanının yapısına yakın, sade sunucu listesi, terminal, araç çubuğu ve karşılama ekranı.
- **Remote / Local / Both** görünümleri: yerel ve uzak dosyalar yan yana; panel genişliği değiştirilebilir.
- Yerel klasör gezinmesi, yol düzenleme, filtre, gizli dosyalar ve **Ctrl/Shift çoklu seçimi**.
- Explorer'dan **birden çok dosya ve klasör bırakma**, uzak klasör üstüne bırakma ve yerel panelden uzak klasöre sürükleme.
- Klasör yapısı ve boş klasörleri koruyan toplu yükleme/indirme. Both görünümünde indirmeler görünür yerel klasöre gider.
- Klasör birleştirme, **Skip / Replace** politikası, staging ve değiştirme hatasında eski dosyayı geri alma.
- Oturum içi transfer kuyruğu, iptal, dosya/byte ilerlemesi ve araç çubuğunda transfer özeti. Sekme değiştirmek transferi durdurmaz.

## Kullanım

Sunucuyu açmak için listedeki kayda çift tıklayın. Sağdaki Files panelinde Both'u seçin. Yerel dosyaları Ctrl/Shift ile seçip uzak alana/klasöre sürükleyin veya Explorer'dan bir grup dosya bırakın. Açılan pencerede hedefi ve mevcut dosya politikasını kontrol edip aktarımı başlatın. Devam eden aktarım sırasında eklenen işler sıraya alınır.

## Doğrulama

8 Rust testi, 7 Chromium arayüz testi ve Clippy geçti. Gerçek Windows uygulamasının ayrı, geçici profilinde native event köprüsü, çoklu yükleme, iç sürükleme, iç içe klasör indirme ve dosya içerikleri doğrulandı. Fiziksel Explorer fare hareketi yerine aynı Tauri drop olayı gönderilmiştir; bu ayrım ve diğer sınırlar [doğrulama kaydında](https://github.com/HarunBulbull/ShellDock-Rust/blob/v0.2.0/docs/VALIDATION_v0.2.0.md) açıklanır.

## Dosyalar

- `ShellDock_0.2.0_x64-setup.exe`: Windows x64 kurulum paketi.
- `ShellDock_0.2.0_windows-x64.zip`: uygulama ve lisansları içeren taşınabilir paket.
- `ShellDock_0.2.0_windows-x64.exe`: doğrudan çalıştırılabilir uygulama.
- `SHA256SUMS.txt`: SHA-256 doğrulama değerleri.

Windows 10/11 x64 ve WebView2 gerekir. Rust/Node.js/Perl yalnızca kaynak geliştirmede kullanılır. Bu önizleme kod imzalı değildir. Güncellemeden önce açık eski ShellDock pencerelerini kapatın.

Kuyruk bellektedir; kalıcı devam/pause/resume yoktur. Sembolik bağlantılar/junctionlar takip edilmez. Replace atomik değildir; geri alma başarısız olursa yedeğin yolu gösterilir. Senkronizasyon, Explorer'a dışa sürükleme ve diğer eksikler için [özellik planına](https://github.com/HarunBulbull/ShellDock-Rust/blob/v0.2.0/docs/PARITY.md) bakın.
