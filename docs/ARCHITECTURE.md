# Teknik kararlar

## Tauri 2 + React + TypeScript

React arayüzü Windows WebView2 içinde çalışır. Ağ, SSH, SFTP ve kimlik bilgileri Rust komutları üzerinden yönetilir. Arayüz kabuk komutları oluşturmaz. Tauri shell eklentisi ve genel amaçlı komut çalıştırma izni verilmez. Uzak web içerikleri uygulama içine yüklenmez; CSP ağ bağlantılarını IPC ile sınırlar.

Bu bir masaüstü uygulamasıdır; ayrı web backend'i, Node sidecar veya Electron çalışma zamanı gerektirmez. Node yalnızca geliştirme ve testte kullanılır.

## Taşıma

İlk Rust taşıması `ssh2` / libssh2 kullanır. Karşılaştırılan Windows OpenSSH + ConPTY yaklaşımı terminal için uygundur fakat parola köprüleme ve SFTP batch çıktısı yönetimi ek süreç karmaşıklığı getirir. Süreç içi taşıma SFTP için byte ilerlemesini ve ortak host key doğrulamasını doğrudan sağlar.

Windows'ta `openssl-on-win32` + `vendored-openssl` etkinleştirilmiştir. İlk gerçek test varsayılan WinCNG arka ucunda şifreli özel anahtar uyumsuzluğunu gösterdi; ayrıca derlenen WinCNG arka ucu Ed25519 içermiyordu. Statik OpenSSL ile Ed25519 host anahtarı, şifreli RSA ve OpenSSH Ed25519 kullanıcı anahtarı testleri geçti. Son kullanıcıya ayrı OpenSSL veya Perl kurulumu gerekmez.

İlk el sıkışması anahtarı alır; kimlik bilgisi göndermez. Kullanıcı kararı sonrasında gerçek bağlantıda anahtar **tekrar** karşılaştırılır. SFTP bağlantıları da oturumun sabitlenmiş anahtarıyla doğrulanır. Değişen anahtar sessiz kabul edilmez.

Her etkileşimli SSH oturumunun bir işçi thread'i vardır. Girdi/boyut/kapama mesajları `mpsc`, çıktı Tauri `Channel` üzerinden taşınır. Ağ işlemleri async komutlardan blocking pool'a aktarılır. UI kapanınca oturum kapama mesajı gönderilir; doğal çıkışta oturum kaydı temizlenir.

SFTP şu anda işlem başına ayrı bağlantı açar. İleride oturum başına SFTP işçisi ve sınırlı paralellik gerekir. MFA, jump host, proxy ve OpenSSH config içe aktarma başlangıç sürümüne dahil değildir. libssh2 algoritma ve anahtar formatı uyumluluğu Windows üzerinde ayrıca doğrulanmalıdır.

## Kalıcılık ve sırlar

Bağlantı metaverisi/güvenilen anahtarlar uygulama veri dizininde JSON; parola ve passphrase `keyring` üzerinden Windows Credential Manager içindedir. JSON önce geçici dosyaya yazılır ve yeniden adlandırılır. Bozuk JSON başlangıçta sessiz sıfırlanmaz. Şema sürümleme, yedekleme ve migration sonraki aşamadır.

Aktif oturum bağlamında sır `Zeroizing<String>` ile tutulur; SFTP yeniden bağlanırken kullanılır. JavaScript parola alanı bağlantı sonrasında temizlenir; JS çalışma zamanındaki eski kopyalar için bellek sıfırlama garantisi yoktur. Telemetri veya terminal çıktısı kaydı eklenmemiştir.

## Veri güvenilirliği

v0.2.0 dosya yöneticisi `files.rs` içindeki batch motorunu kullanır. Seçilen köklerden rekürsif plan çıkarılır; iç içe ve boş klasörler korunur. Bağlantılar/junctionlar takip edilmez. Dosyalar önce aynı hedef klasörde benzersiz gizli `.part` dosyasına yazılır. Skip mevcut hedefi korur. SFTP v3 Replace için önce eski hedef yedeğe taşınır; yeni dosya yerleştirilemezse yedek geri yüklenir. Bu işlem atomik değildir; geri alma da başarısız olursa korunmuş yedeğin yolu hata mesajında gösterilir. Normal hata/iptalde staging dosyası temizlenir; zorla kapanma için garanti yoktur.

React paneli oturum başına bellekte sıralı kuyruk tutar. Sekme/panel gizlenmesi paneli unmount etmez; iş ve kuyruk korunur. Oturum kapatma/değiştirme iptal tokenını ayarlar ve bekleyen işleri temizler. İptal worker tarafından planlama, dosya ve blok sınırlarında kontrol edilir; bloklayan ağ çağrısının timeout'una kadar gecikebilir. Kuyruk kalıcı değildir; pause/resume/retry henüz yoktur.

Explorer girişleri `tauri://drag-*` olaylarından gerçek dosya yollarını alır; fiziksel koordinatlar cihaz piksel oranıyla CSS koordinatlarına çevrilir. Hedef görünür uzak panel veya imlecin altındaki uzak klasördür. Yerel panel iç sürükleme için özel bir DOM veri türü kullanır. İki yol da aynı onay ve transfer motoruna gider.

Uzak düzenleyici 2 MB UTF-8 sınırındadır. Kaydetme açık kullanıcı onaylıdır, doğrudan truncate/write yapar. Atomik kayıt ve uzak sürüm çatışması denetimi tamamlanmadan kritik dosyalar için güvenilirlik iddiası yapılmaz.

## Doğrulama

Arayüz testleri gerçek Chromium + taklit Tauri IPC kullanır. Host güven kararı olmadan `connect` çağrılmadığını, sekme bağımsızlığını ve SFTP seçimini denetler; tarayıcı hatalarını başarısız sayar.

Rust testlerindeki Node SSH fixture loopback'te rastgele port açar; RSA/Ed25519 anahtarları ve SFTP dosyaları geçicidir. SSH/credential testlerine ek olarak batch yükleme/indirme, boş ve iç içe klasörler, Skip/Replace, iptal temizliği ve sunucunun rename hatasında rollback doğrulanır. Sekiz Rust testi Windows üzerinde geçti.

Gerçek optimize `.exe`, geçici loopback CDP portuyla Playwright üzerinden açıldı; WebView2 içeriği, Rust IPC ve bağlantı formu doğrulandı. Ayrı OpenSSL DLL bağımlılığı bulunmadığı PE import tablosundan kontrol edildi. NSIS x64 kurulumu üretildi; kurulum/kaldırma sihirbazı henüz denenmedi. İlk yerel release paketinde aynı kaynak sürümünden derlenmiş `/O2` statik OpenSSL kütüphaneleri yeniden kullanıldı; normal `npm run tauri build` gerektiğinde bu kütüphaneleri vendored kaynaklardan derler.

## Sonraki mimari adımlar

1. OpenSSH üzerinde vim/tmux/Unicode/resize/uzun oturum ve agent testlerini genişlet; mevcut loopback protokol ve credential testlerini koru.
2. `lib.rs` içindeki taşıma, persistence, credentials ve transferleri bağımsız modüllere ayır; testleri bu servislerin arayüzüne bağla.
3. Mevcut sıralı motorun büyük dosya/kesinti/disk doluluğu testlerini genişlet; kalıcı kuyruk ve devam ekle.
4. Şema migration, tercihler, oturum restorasyonu, erişilebilir modal odak yönetimi ve Türkçe yerelleştirme ekle.
5. Kaynak projedeki ileri SFTP özellikleri ve Windows entegrasyonunu tamamla; imzalı kurulum dağıtımını ayrı doğrula.
