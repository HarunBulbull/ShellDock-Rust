# ShellDock for Windows v0.2.1 — dosya işlemleri düzeltmesi

- Windows WebView2’de native drop handler ile çakışan yerel HTML5 sürüklemesi kaldırıldı. Yerel panelden uzak klasöre çoklu sürükleme pointer capture ile çalışır.
- Explorer dosyaları doğrudan mevcut WebView’ın `onDragDropEvent` dinleyicisiyle alınır. Hedef dışına bırakmada açıklama gösterilir; dinleyici kurulum hataları gizlenmez.
- Onay diyaloğunda varsayılan **Replace existing files** seçeneğidir. **Skip** seçilirse atlanan dosyalar yüklenmiş sayılmaz; tamamı atlandıysa “No files transferred” gösterilir.
- Her yükleme sonrasında hedef dosya sunucudan tekrar okunup yerel kaynakla bayt bayt karşılaştırılır. Yanlış içerik veya boyutta başarı verilmez. Bu doğrulama ek indirme trafiği gerektirir.
- Yerel dosya/klasör yeniden adlandırma ve çoklu silme eklendi. Yerel klasör silme alt içerikleri de siler ve açık onay ister.
- Her iki dosya listesinde **Delete**, **F2**, harfle seçim, oklar, Home/End ve Ctrl+A desteği eklendi. Yazı alanlarında bu kısayollar devreye girmez.

## Doğrulama

9 Rust testi, 9 Chromium arayüz testi, Clippy ve üretim derlemesi geçti. Yalıtılmış gerçek Windows uygulamasında çoklu yükleme, aynı dosyanın değiştirilip tekrar yüklenmesi, gerçek pointer sürüklemesi, rekürsif indirme, indirilen baytlar, harfle seçim, F2 ve Delete doğrulandı. Yazmayı başarılı raporlayıp yanlış içerik döndüren test sunucusu başarı yerine hata üretir.

Explorer’ın gerçek pencereler arası OLE sürüklemesi otomasyon aracının pencere sınırı nedeniyle tamamlanamadı. Native WebView’a hedeflenmiş aynı Tauri olayı test edildi; bu fiziksel Explorer hareketiyle aynı test değildir. Ayrıntılar: [doğrulama kaydı](https://github.com/HarunBulbull/ShellDock-Rust/blob/v0.2.1/docs/VALIDATION_v0.2.1.md).

Kurulumdan önce açık ShellDock pencerelerini kapatın. Settings & about içinde **0.2.1** göründüğünü kontrol edin. Uygulama kod imzalı değildir. Kalıcı transfer kuyruğu, pause/resume, senkronizasyon ve Explorer’a dışa sürükleme henüz yoktur.
