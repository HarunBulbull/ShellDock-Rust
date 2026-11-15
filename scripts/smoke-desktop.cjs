// Read-only native smoke test. It launches only this project's built executable,
// opens and cancels a connection form, and never writes a saved connection.
const { chromium } = require("@playwright/test");
const { spawn } = require("node:child_process");
const { resolve } = require("node:path");
const { access, mkdir } = require("node:fs/promises");
const net = require("node:net");
const assert = require("node:assert/strict");

async function main() {
  if (process.platform !== "win32")
    throw new Error("This smoke test requires Windows and WebView2.");
  const executable = resolve(
    process.argv[2] || "src-tauri/target/release/shelldock.exe",
  );
  await access(executable);
  const reservation = net.createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const child = spawn(executable, [], {
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
    stdio: "ignore",
  });
  let browser;
  let startupError;
  child.on("error", (error) => {
    startupError = error;
  });
  try {
    const deadline = Date.now() + 45_000;
    while (true) {
      if (startupError) throw startupError;
      if (child.exitCode !== null)
        throw new Error(`Application exited during startup: ${child.exitCode}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) break;
      } catch {}
      if (Date.now() > deadline)
        throw new Error(
          "WebView2 did not expose the test debugging endpoint within 45 seconds.",
        );
      await new Promise((done) => setTimeout(done, 250));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    let page;
    for (let attempt = 0; attempt < 100; attempt++) {
      page = context
        .pages()
        .find(
          (candidate) =>
            !candidate.url().startsWith("devtools:") &&
            candidate.url() !== "about:blank",
        );
      if (page) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    if (!page) throw new Error("Application WebView page was not created.");
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("heading", { name: "A place for every connection." })
      .waitFor();
    assert.equal(await page.getByText("Browser preview ·").count(), 0);
    const connections = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("list_connections"),
    );
    assert.ok(
      Array.isArray(connections),
      "Native IPC must return the saved connection list.",
    );
    await page.getByRole("button", { name: "Add a server" }).click();
    await page.getByRole("dialog").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Save connection" }).isEnabled(),
      true,
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await mkdir("docs/screenshots", { recursive: true });
    await page.screenshot({ path: "docs/screenshots/windows-native.png" });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: native WebView2 startup, Rust IPC, desktop connection form, no browser errors.",
    );
  } finally {
    if (browser) await browser.close();
    child.kill();
    await new Promise((done) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        done();
      else child.once("exit", done);
    });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
