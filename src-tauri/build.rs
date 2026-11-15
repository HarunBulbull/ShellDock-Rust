fn main() {
    tauri_build::build();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // Vendored OpenSSL removes its build directory, including ossl_static.pdb.
        // Its C debug symbols are unavailable; application Rust symbols remain intact.
        println!("cargo:rustc-link-arg=/IGNORE:4099");
    }
}
