const { existsSync } = require("node:fs");
const { join, resolve, delimiter } = require("node:path");
const { homedir } = require("node:os");
const { spawn } = require("node:child_process");

function toolchainEnvironment() {
  const environment = { ...process.env };
  // Build tools must not inherit a locale unavailable in native Windows Perl.
  if (process.platform === "win32") environment.LC_ALL = "C";
  const paths = [join(homedir(), ".cargo", "bin")];
  const perl = [
    resolve(".tools/perl/bin/perl.exe"),
    "C:/Strawberry/perl/bin/perl.exe",
  ].find(existsSync);
  if (perl) {
    environment.OPENSSL_SRC_PERL ||= perl;
  }
  environment.PATH = [
    ...paths,
    environment.PATH || environment.Path || "",
  ].join(delimiter);
  return environment;
}
function run(command, args) {
  const child = spawn(command, args, {
    env: toolchainEnvironment(),
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
module.exports = { toolchainEnvironment, run };
