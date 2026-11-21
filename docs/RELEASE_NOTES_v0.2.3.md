# ShellDock for Windows v0.2.3 — kenar çubuğu düzeltmesi, büyük klasör indirme ve anında Masaüstü/Explorer dışa sürükleme

- **Kenar çubuğu bağlantı noktası düzeltmesi:** Açık sekmeye sahip sunucu satırlarında yeşil `.status-dot.online` göstergesinin `.connection-open > span` CSS kuralı nedeniyle yatay yeşil elipse dönüşmesi düzeltildi; gösterge artık 6×6 px dairesel kalır ve satır vurgusuyla hover kenar çakışması giderildi.
- **2.000 öğe dışa sürükleme sınırının kaldırılması:** Uzak panelden Windows Masaüstü / Explorer’a sürükle-bırak sırasında çok klasörlü ağaçları (ör. tüm Minecraft sunucusu) engelleyen `"External drag is limited to 2,000 items. Use Download for larger trees."` sınırı kaldırıldı (derinlik koruması `128`).
- **Anında, bloklamayan Masaüstü / Explorer sürükle-bırak (`SHDoDragDrop` + MTA + `IDataObjectAsyncCapability`):**
  - Dışa sürükleme başlatılırken tüm SFTP ağacını önceden tarama kaldırıldı; `SHDoDragDrop` pencere kenarında anında başlar ve `QueryContinueDrag` WebView2 süreç sınırı boyunca fiziksel fare basılı durumunu da (`GetAsyncKeyState`) denetler.
  - `RemoteDataObject` ayrı bir COM MTA iş parçacığında çalışır, `DragEnter` sırasında kök ipuçlarını anında döner, bırakma anında arka planda SFTP ağacını tarar ve dosyaları `<= 2 MB` için bellekten, `> 2 MB` için kanallı SFTP akışıyla (`StreamingSftpStream`) Explorer kopyalama penceresine aktarır. Arka plan sürükleme hataları arayüze de iletilir.
- **Büyük klasör ağaçlarında hızlı toplu aktarım:** `plan_download` içinde `sftp.readdir` ile gelen `FileStat` yeniden kullanılarak fazladan `lstat` gidiş-gelişleri kaldırıldı, `"Preparing transfer…"` aşamasına canlı ilerleme eklendi, planlama limiti `2.000.000` öğeye çıkarıldı, özel dosyalar (socket/FIFO) atlandı ve indirmede dosya başına NTFS `sync_all()` yerine `flush()` kullanıldı.

## Doğrulama

12 Rust testi (2.200+ öğeli klasör ağacı + >2 MB akışlı indirme ve Windows Shell `IDropTarget` MTA asenkron bırakma testi dahil), 14 Chromium arayüz testi, Clippy (`--all-targets -- -D warnings`) ve üretim derlemesi geçti. Ayrıntılar: [v0.2.3 doğrulama kaydı](https://github.com/HarunBulbull/ShellDock-Rust/blob/v0.2.3/docs/VALIDATION_v0.2.3.md).

Kurulumdan önce açık eski ShellDock pencerelerini kapatın; ilk açılışta **v0.2.3** sürümünü kontrol edin. Uygulama kod imzalı değildir.
