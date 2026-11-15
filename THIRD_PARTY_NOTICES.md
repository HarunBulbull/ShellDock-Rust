# Third-party notices

The original ShellDock project and application icon are by Harun Bülbül, licensed under MIT. The original license is preserved in LICENSE. Reference source is excluded from this repository via `.gitignore`.

Runtime components include Tauri (MIT/Apache-2.0), React (MIT), xterm.js and addons (MIT), Lucide (ISC), ssh2 Rust bindings (MIT/Apache-2.0), libssh2 (BSD-style license), keyring (MIT/Apache-2.0), serde (MIT/Apache-2.0), sha2 (MIT/Apache-2.0), base64 (MIT/Apache-2.0), uuid (MIT/Apache-2.0), and zeroize (MIT/Apache-2.0).

Development tools include Vite, TypeScript, Playwright, Prettier and the Node ssh2 test fixture dependency. Exact resolved package versions are recorded in package-lock.json and src-tauri/Cargo.lock. Consult upstream packages for full license texts and transitive dependency notices before distribution.

The Windows SSH transport statically links OpenSSL 3.6.3 (Apache-2.0) instead of using libssh2's default WinCNG backend. Full OpenSSL and libssh2 license texts are included in `licenses/` and bundled with the installer. Strawberry Perl is a development-only build tool, downloaded from its official release with a pinned SHA-256 checksum; it is not included in the application.
