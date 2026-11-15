const { run } = require("./toolchain.cjs");
run(process.execPath, [
  require.resolve("@tauri-apps/cli/tauri.js"),
  ...process.argv.slice(2),
]);
