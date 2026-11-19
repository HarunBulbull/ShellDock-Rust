// Full native file workflow test. Requires a separately built, unique smoke
// identifier; it refuses to write fixture connections into the real app profile.
const { chromium, expect } = require("@playwright/test");
const { spawn } = require("node:child_process");
const {
  access,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { resolve, join, dirname, basename } = require("node:path");
const net = require("node:net");
const assert = require("node:assert/strict");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function main() {
  if (!process.argv[2]) throw Error("Pass the isolated smoke executable.");
  await access(resolve(process.argv[2]));
  const fixture = await mkdtemp(join(tmpdir(), "shelldock-native-files-"));
  const source = join(fixture, "source"),
    destination = join(fixture, "download");
  await mkdir(join(source, "project", "nested"), { recursive: true });
  await mkdir(destination);
  await writeFile(join(source, "first.txt"), "native Explorer batch 🦀");
  await writeFile(join(source, "second.txt"), "native internal drag");
  await writeFile(
    join(source, "project", "nested", "inside.txt"),
    "nested upload/download",
  );
  const ssh = spawn(process.execPath, [resolve("scripts/test-server.cjs")], {
    stdio: ["ignore", "pipe", "inherit"],
    windowsHide: true,
  });
  const sshPort = await new Promise((done, reject) => {
    ssh.stdout.once("data", (data) => done(Number(data.toString().trim())));
    ssh.once("error", reject);
    ssh.once("exit", () => reject(Error("SSH fixture exited before startup")));
  });
  const reservation = net.createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const port = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const app = spawn(resolve(process.argv[2]), [], {
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
    },
  });
  let browser;
  let page;
  let launchError;
  app.on("error", (error) => {
    launchError = error;
  });
  let ownedPaths = [];
  let identifier = "";
  try {
    for (let i = 0; ; i++) {
      if (launchError) throw launchError;
      if (app.exitCode !== null)
        throw Error(`Native application exited: ${app.exitCode}`);
      if (i > 160) throw Error("Native application startup timed out");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) break;
      } catch {}
      await delay(250);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    for (let i = 0; i < 150; i++) {
      page = browser
        .contexts()[0]
        .pages()
        .find(
          (p) => p.url() !== "about:blank" && !p.url().startsWith("devtools:"),
        );
      if (page) break;
      await delay(100);
    }
    if (!page) throw Error("Application page missing");
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.stack || e.message));
    identifier = await page.evaluate(() =>
      window.__TAURI_INTERNALS__.invoke("plugin:app|identifier"),
    );
    assert.match(
      identifier,
      /^com\.harunbulbul\.shelldock\.smoke\.[a-f0-9]+$/,
      "Refusing to modify a production profile",
    );
    ownedPaths = await page.evaluate(() =>
      Promise.all(
        [14, 15].map((directory) =>
          window.__TAURI_INTERNALS__.invoke("plugin:path|resolve_directory", {
            directory,
          }),
        ),
      ),
    );
    const connection = {
      id: "native-file-fixture",
      name: "Local SFTP fixture",
      host: "127.0.0.1",
      port: sshPort,
      username: "tester",
      auth: "password",
      privateKey: "",
      group: "Integration",
      notes: "Disposable local fixture",
      favorite: false,
    };
    await page.evaluate(async (connection) => {
      await window.__TAURI_INTERNALS__
        .invoke("delete_credential", { id: connection.id })
        .catch(() => {});
      await window.__TAURI_INTERNALS__.invoke("save_connection", {
        connection,
      });
    }, connection);
    await page.reload();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Local SFTP fixture" })
      .dblclick();
    await page.getByLabel("Password", { exact: true }).fill("fixture-password");
    await page.getByRole("button", { name: "Connect to server" }).click();
    await page
      .getByRole("button", { name: "Trust this key and connect" })
      .click();
    await expect(page.getByText("1 active sessions")).toBeVisible();
    const local = page.getByRole("listbox", { name: "Local directory" }),
      remote = page.getByRole("listbox", { name: "Remote directory" });
    await page.getByLabel("Local path", { exact: true }).fill(source);
    await page.getByLabel("Local path", { exact: true }).press("Enter");
    await expect(
      local.getByRole("option", { name: /first.txt/ }),
    ).toBeVisible();
    const box = await remote.boundingBox();
    assert.ok(box);
    // Deliver the same native event payload that Windows Explorer sends. This
    // exercises the real Tauri event bridge, coordinates, confirmation and Rust IPC.
    if (process.env.SHELLDOCK_PHYSICAL_DROP) {
      await writeFile(
        resolve(".tools/physical-drop-ready.json"),
        JSON.stringify({ source, fixture, port, identifier }),
      );
      console.log("Waiting for physical Explorer drop from " + source);
      await expect(
        page.getByRole("heading", { name: "Upload 2 items" }),
      ).toBeVisible({ timeout: 300000 });
    } else
      await page.evaluate(
        ({ paths, x, y }) =>
          window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", {
            target: { kind: "Webview", label: "main" },
            event: "tauri://drag-drop",
            payload: {
              paths,
              position: { x: x * devicePixelRatio, y: y * devicePixelRatio },
            },
          }),
        {
          paths: [join(source, "first.txt"), join(source, "project")],
          x: box.x + 60,
          y: box.y + box.height - 30,
        },
      );
    await expect(
      page.getByRole("heading", { name: "Upload 2 items" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Start upload" }).click();
    await expect(page.getByText("Transfer complete")).toBeVisible();
    await expect(
      remote.getByRole("option", { name: /first.txt/ }),
    ).toBeVisible();
    // Upload the same path again with different bytes. Verify the destination,
    // rather than trusting a success label or a mocked transfer response.
    await writeFile(
      join(source, "first.txt"),
      "replacement verified from server",
    );
    await local.getByRole("option", { name: /first.txt/ }).click();
    await page.getByRole("button", { name: "Upload selection" }).click();
    await expect(
      page.getByRole("combobox", { name: "Conflict policy" }),
    ).toHaveValue("replace");
    await page.getByRole("button", { name: "Start upload" }).click();
    await expect(page.getByText("Transfer complete — verified")).toBeVisible();
    await local
      .getByRole("option", { name: /second.txt/ })
      .dragTo(remote.getByRole("option", { name: /project/ }));
    await expect(
      page.getByRole("heading", { name: "Upload 1 item", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Start upload" }).click();
    await expect(page.getByText("Transfer complete")).toBeVisible();
    await page.getByLabel("Local path", { exact: true }).fill(destination);
    await page.getByLabel("Local path", { exact: true }).press("Enter");
    await expect(local.getByRole("option")).toHaveCount(0);
    await remote.getByRole("option", { name: /first.txt/ }).click();
    await remote
      .getByRole("option", { name: /project/ })
      .click({ modifiers: ["Control"] });
    await page.getByRole("button", { name: "Download selection" }).click();
    await page.getByRole("button", { name: "Start download" }).click();
    await expect
      .poll(
        async () => {
          try {
            return await readFile(
              join(destination, "project", "second.txt"),
              "utf8",
            );
          } catch {
            return "";
          }
        },
        { timeout: 20000 },
      )
      .toBe("native internal drag");
    assert.equal(
      await readFile(join(destination, "first.txt"), "utf8"),
      "replacement verified from server",
    );
    assert.equal(
      await readFile(
        join(destination, "project", "nested", "inside.txt"),
        "utf8",
      ),
      "nested upload/download",
    );
    await expect(page.getByText("Transfer complete")).toBeVisible();
    await page.getByRole("button", { name: "Show all transfers" }).click();
    await expect(page.getByRole("dialog", { name: "Transfers" })).toContainText(
      "completed",
    );
    await page.getByRole("button", { name: "Close transfers" }).click();
    await mkdir("docs/screenshots", { recursive: true });
    await page.screenshot({
      path: "docs/screenshots/windows-files-native.png",
    });
    await local.focus();
    await page.keyboard.press("f");
    await expect(
      local.getByRole("option", { name: /first.txt/ }),
    ).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("F2");
    await page
      .getByRole("dialog", { name: "File operation" })
      .getByLabel("Name", { exact: true })
      .fill("renamed.txt");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(
      local.getByRole("option", { name: /renamed.txt/ }),
    ).toBeVisible();
    assert.equal(
      await readFile(join(destination, "renamed.txt"), "utf8"),
      "replacement verified from server",
    );
    await local.getByRole("option", { name: /renamed.txt/ }).click();
    await local
      .getByRole("option", { name: /project/ })
      .click({ modifiers: ["Control"] });
    await page.keyboard.press("Delete");
    await expect(
      page.getByRole("heading", { name: "Delete local items?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(local.getByRole("option")).toHaveCount(0);
    await assert.rejects(access(join(destination, "renamed.txt")));
    await assert.rejects(access(join(destination, "project")));
    // Verify real WebView2 Remote -> Local pointer drag-and-drop.
    await remote.getByRole("option", { name: /first.txt/ }).dragTo(local);
    await expect(
      page.getByRole("heading", { name: "Download 1 item", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Start download" }).click();
    await expect(
      local.getByRole("option", { name: /first.txt/ }),
    ).toBeVisible();
    // Verify double-click remote editor + Ctrl+S save in real WebView2 + SFTP.
    await remote.getByRole("option", { name: /first.txt/ }).dblclick();
    const editor = page.getByRole("region", {
      name: "Remote editor for first.txt",
    });
    await expect(editor).toBeVisible();
    await editor.locator(".cm-content").click();
    await page.keyboard.type("\nedited-in-native");
    await page.keyboard.press("Control+s");
    await expect(editor.getByText("Synced with server")).toBeVisible();
    await editor.getByRole("button", { name: "Close file" }).click();
    // Verify remote recursive bulk delete removes nested folders and files in one batch.
    await remote.getByRole("option", { name: /first.txt/ }).click();
    await remote
      .getByRole("option", { name: /project/ })
      .click({ modifiers: ["Control"] });
    await page.keyboard.press("Delete");
    await expect(
      page.getByRole("heading", { name: "Delete remote items?" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(remote.getByRole("option", { name: /project/ })).toHaveCount(
      0,
    );
    await expect(remote.getByRole("option", { name: /first.txt/ })).toHaveCount(
      0,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: native drop, multi-root upload, overwrite bytes, two-way pointer drag, remote editor, recursive remote bulk delete, typeahead, F2 rename, Delete and transfer summary.",
    );
  } finally {
    if (page)
      await page
        .evaluate(() =>
          window.__TAURI_INTERNALS__
            .invoke("delete_credential", { id: "native-file-fixture" })
            .catch(() => {}),
        )
        .catch(() => {});
    if (browser) await browser.close();
    app.kill();
    ssh.kill();
    await delay(1200);
    const roots = [process.env.APPDATA, process.env.LOCALAPPDATA]
      .filter(Boolean)
      .map((p) => resolve(p).toLowerCase());
    for (const path of new Set(ownedPaths)) {
      const target = resolve(path);
      if (
        basename(target) === identifier &&
        identifier.startsWith("com.harunbulbul.shelldock.smoke.") &&
        roots.includes(dirname(target).toLowerCase())
      )
        await rm(target, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 200,
        });
    }
    if (
      dirname(fixture) === resolve(tmpdir()) &&
      basename(fixture).startsWith("shelldock-native-files-")
    )
      await rm(fixture, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
