# ShellDock for Windows v0.2.2 — kullanılabilirlik, çift yönlü sürükleme ve uzaktan dosya editörü

- **Çift tıklamada otomatik bağlanma:** Windows Credential Manager’da kayıtlı şifre/parola varsa veya `agent` / `privateKey` kullanılıyorsa bağlantı listesinde çift tıklama doğrudan bağlantıyı başlatır. Zaten açık olan sunucu sekmeleri düz çift tıklamada odaklanır (`Shift + çift tıklama` veya sağ tık menüsü yeni sekme açar).
- **Kimlik bilgisi yönetimi ve Quick Connect:** Bağlantı Düzenleyici içinden parola tanımlama/temizleme ve **Test Connection** eklendi. `Ctrl+Shift+N` ile tek seferlik Quick Connect bağlantısı kurulabilir.
- **Tek örnek koruması:** `tauri-plugin-single-instance` ile ikinci bir uygulama örneği açıldığında WebView2 profil çakışmasıyla çökmek yerine mevcut pencere öne getirilir.
- **Çift yönlü sürükle-bırak:**
  - Yerel ↔ Uzak iki yönlü pointer sürüklemesi hedef klasör vurgusuyla çalışır.
  - Windows Explorer’dan yerel panele bırakılan öğeler yerel klasöre kopyalanır.
  - Uzak panelden pencere dışına (Explorer / Masaüstü) sürükleme için Win32 OLE `DoDragDrop` entegrasyonu eklendi.
- **MobaXterm tarzı uzaktan dosya editörü:** Uzak metin/konfigürasyon dosyalarına (`.yml`, `.json`, `.env`, `.conf`, `.ts`, `.py` vb.) çift tıklandığında oturum içinde terminali engellemeyen CodeMirror 6 editörü açılır (sözdizimi renklendirme, `Tab` ile 2 boşluk girintisi, `Ctrl+F`/`Ctrl+H`, `Ctrl+S` onaysız SFTP kaydetme, Split görünüm, uzak `mtime` çakışma kontrolü, >2 MB baştan/sondan salt-okunur önizleme). İstenirse dosya varsayılan yerel uygulamada açılıp otomatik senkronize edilebilir.
- **Özyinelemeli toplu uzak silme & SFTP havuzu:** Seçili uzak dosya ve iç içe klasörler tek havuzlanmış SFTP oturumunda sembolik bağ hedeflerine inmeden silinir (`remote_delete_batch`); hatalar modal içinde gösterilir.
- **Dosya yöneticisi ve terminal iyileştirmeleri:** Yerel/uzak sağ tık menüleri, `Name`/`Size`/`Modified` sıralama, Geri/İleri geçmişi, sürücü/kısayol seçicisi, `duplicate`/`chmod`/yeni dosya oluşturma, bağlantı kopmasında terminal geçmişini koruyan `.reconnect-banner`, `Ctrl+C` akıllı kopyalama, `Ctrl+Shift+V` yapıştırma, font ölçekleme (`Ctrl++`/`-`/`0`), katlanabilir gruplar ve tüm modallarda `Escape` desteği eklendi.

## Doğrulama

10 Rust testi, 13 Chromium arayüz testi, Clippy (`--all-targets -- -D warnings`) ve üretim derlemesi geçti. Yalıtılmış gerçek WebView2 uygulamasında yerel ↔ uzak sürükleme, uzaktan editör açma + `Ctrl+S` kaydetme, özyinelemeli toplu uzak silme, harfle seçim, `F2` ve `Delete` doğrulandı. Ayrıntılar: [v0.2.2 doğrulama kaydı](https://github.com/HarunBulbull/ShellDock-Rust/blob/v0.2.2/docs/VALIDATION_v0.2.2.md).

Kurulumdan önce açık eski ShellDock pencerelerini kapatın; ilk bağlantı açılışında **0.2.2** sürümünü kontrol edin. Uygulama kod imzalı değildir. Uzak panelden fiziksel Windows Explorer penceresine dışa `DoDragDrop` sürüklemesi yalnızca derleme ve statik denetimden geçti; masaüstünde elle doğrulanmalıdır.
