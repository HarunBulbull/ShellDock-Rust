// Read-only native smoke test. It launches only this project's built executable,
// opens and cancels a connection form, and never writes a saved connection.
const { chromium } = require("@playwright/test");
const { spawn } = require("node:child_process");
const { resolve, join, dirname, basename } = require("node:path");
const { tmpdir } = require("node:os");
const { access, mkdir, mkdtemp, writeFile, rm } = require("node:fs/promises");
const net = require("node:net");
const assert = require("node:assert/strict");

async function main() {
  if (process.platform !== "win32")
    throw new Error("This smoke test requires Windows and WebView2.");
  const executable = resolve(
    process.argv[2] || "src-tauri/target/release/shelldock.exe",
  );
  await access(executable);
  const localFixture = await mkdtemp(join(tmpdir(), "shelldock-native-local-"));
  await mkdir(join(localFixture, "folder"));
  await writeFile(
    join(localFixture, "merhaba.txt"),
    "Native local browser fixture",
  );
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
      .getByRole("heading", { name: "Your Remote Workspace" })
      .waitFor();
    assert.equal(await page.getByText("Browser preview ·").count(), 0);
    const connections = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("list_connections"),
    );
    assert.equal(
      await page.evaluate(() =>
        window.__TAURI_INTERNALS__.invoke("plugin:app|identifier"),
      ),
      "com.harunbulbul.shelldock",
      "Release must use the production application identifier.",
    );
    assert.ok(
      Array.isArray(connections),
      "Native IPC must return the saved connection list.",
    );
    const listing = await page.evaluate(
      (path) => window.__TAURI_INTERNALS__.invoke("list_local", { path }),
      localFixture,
    );
    assert.deepEqual(
      listing.entries.map((entry) => entry.name),
      ["folder", "merhaba.txt"],
    );
    assert.equal(listing.entries[0].directory, true);
    await page
      .getByRole("button", { name: "New Connection", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Save connection" }).isEnabled(),
      true,
    );
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await mkdir("docs/screenshots", { recursive: true });
    // Never write screenshots containing the user's saved server identities.
    // Full file-manager screenshots come from the isolated fixture profile.
    if (connections.length === 0)
      await page.screenshot({ path: "docs/screenshots/windows-native.png" });
    assert.deepEqual(errors, []);
    console.log(
      "PASS: native WebView2 startup, Rust IPC/local filesystem listing, connection form, no browser errors.",
    );
  } finally {
    if (browser) await browser.close();
    child.kill();
    await new Promise((done) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null)
        done();
      else child.once("exit", done);
    });
    if (
      dirname(localFixture) === resolve(tmpdir()) &&
      basename(localFixture).startsWith("shelldock-native-local-")
    )
      await rm(localFixture, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
