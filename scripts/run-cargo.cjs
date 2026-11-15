const { run } = require("./toolchain.cjs");
run(
  process.platform === "win32" ? "cargo.exe" : "cargo",
  process.argv.slice(2),
);
