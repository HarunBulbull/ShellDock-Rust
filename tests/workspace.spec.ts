import { test, expect, type Page } from "@playwright/test";

async function mockDesktop(page: Page) {
  await page.addInitScript(() => {
    const saved = [
      {
        id: "test",
        name: "Integration server",
        host: "127.0.0.1",
        port: 2222,
        username: "tester",
        auth: "password",
        privateKey: "",
        group: "Development",
        notes: "",
        favorite: false,
      },
    ];
    const commands: { cmd: string; args: any }[] = [],
      callbacks = new Map<number, (data: any) => void>(),
      listeners = new Map<number, { event: string; handler: number }>();
    let seq = 0;
    const entry = (name: string, path: string, directory = false) => ({
      name,
      path,
      size: directory ? 0 : 1200,
      directory,
      symlink: false,
      modified: 1700000000,
      permissions: directory ? 0o755 : 0o644,
    });
    Object.assign(window, {
      __commands: commands,
      __savedCreds: [] as string[],
      __trustedFp: null as string | null,
      __emit: (targetEvent: string, payload: unknown) => {
        for (const { event, handler } of listeners.values())
          if (event === targetEvent)
            callbacks.get(handler)?.({ event, payload });
      },
      __drop: (paths: string[], x: number, y: number) => {
        for (const { event, handler } of listeners.values())
          if (event === "tauri://drag-drop")
            callbacks.get(handler)?.({
              event,
              payload: {
                paths,
                position: { x: x * devicePixelRatio, y: y * devicePixelRatio },
              },
            });
      },
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback: (cb: (data: unknown) => void) => {
          callbacks.set(++seq, cb);
          return seq;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (cmd: string, args: Record<string, any>) => {
          commands.push({ cmd, args });
          if (cmd === "plugin:event|listen") {
            const id = ++seq;
            listeners.set(id, { event: args.event, handler: args.handler });
            return id;
          }
          if (cmd === "plugin:event|unlisten") {
            listeners.delete(args.eventId);
            return;
          }
          if (cmd === "list_connections") return saved;
          if (cmd === "list_saved_credentials")
            return (window as any).__savedCreds;
          if (cmd === "save_credential" || cmd === "delete_credential") return;
          if (cmd === "probe_host")
            return {
              fingerprint: "SHA256:test-fingerprint",
              previous: (window as any).__trustedFp,
            };
          if (cmd === "trust_host") {
            (window as any).__trustedFp = args.fingerprint;
            return;
          }
          if (cmd === "connect") return `session-${++seq}`;
          if (cmd === "remote_home") return "/home/tester";
          if (cmd === "list_remote")
            return {
              path: args.path,
              parent: args.path === "/" ? null : "/home",
              entries: [
                entry("uploads", `${args.path}/uploads`, true),
                entry("docker-compose.yml", `${args.path}/docker-compose.yml`),
                entry("hello.txt", `${args.path}/hello.txt`),
              ],
            };
          if (cmd === "list_local_places")
            return {
              home: "C:\\Users\\tester",
              desktop: "C:\\Users\\tester\\Desktop",
              downloads: "C:\\Users\\tester\\Downloads",
              documents: "C:\\Users\\tester\\Documents",
              drives: [{ path: "C:\\", label: "C:" }],
            };
          if (cmd === "list_local") {
            const path = args.path || "C:\\Users\\tester\\Desktop";
            return {
              path,
              parent: "C:\\Users\\tester",
              entries: [
                entry("project", `${path}\\project`, true),
                entry("alpha.txt", `${path}\\alpha.txt`),
                entry("beta.txt", `${path}\\beta.txt`),
              ],
            };
          }
          if (cmd === "read_remote")
            return {
              path: args.path,
              text: "services:\n  web:\n    image: nginx\n",
              mtime: 1700000100,
              size: 35,
              permissions: 0o644,
              readOnly: false,
              readOnlyReason: null,
              truncated: false,
              previewMode: null,
              lossyUtf8: false,
              binary: false,
              lineEnding: "LF",
            };
          if (cmd === "write_remote") {
            if ((window as any).__conflictWrite && !args.force)
              throw new Error("CONFLICT:File changed on server.");
            return { mtime: 1700000200, size: args.text.length };
          }
          if (cmd === "remote_delete_batch") {
            if ((window as any).__partialDeleteFail) {
              return {
                deleted: [args.paths[0]],
                failed: [{ path: args.paths[1], error: "Permission denied" }],
              };
            }
            return { deleted: args.paths, failed: [] };
          }
          if (cmd === "transfer_batch") {
            const result = {
              completedBytes: 2400,
              totalBytes: 2400,
              completedFiles: (window as any).__skipAll ? 0 : 2,
              totalFiles: 2,
              skippedFiles: (window as any).__skipAll ? 2 : 0,
              current: "",
              status: "completed",
              bytesPerSec: 12000,
            };
            args.progress.onmessage({
              ...result,
              completedBytes: 1200,
              status: "transferring",
              completedFiles: 0,
            });
            if ((window as any).__holdTransfer)
              await new Promise<void>((resolve) => {
                (window as any).__finishTransfer = resolve;
              });
            else await new Promise((resolve) => setTimeout(resolve, 100));
            args.progress.onmessage(result);
            return result;
          }
          if (cmd === "start_external_drag") return true;
          if (cmd === "save_connection") {
            if ((window as any).__failSave)
              throw new Error("Save validation failed");
            saved.push(args.connection);
            return;
          }
        },
      },
    });
  });
}
async function connect(page: Page) {
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .dblclick();
  await page.getByRole("button", { name: "Connect to server" }).click();
  await page
    .getByRole("button", { name: "Trust this key and connect" })
    .click();
  await expect(page.getByText("1 active sessions")).toBeVisible();
  await expect(
    page.getByRole("listbox", { name: "Local directory" }),
  ).toBeVisible();
}

test("original-style empty workspace and desktop-only connection storage", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your Remote Workspace" }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Choose a server in the sidebar, then double-click to connect automatically.",
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New Connection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save connection" }),
  ).toBeDisabled();
  await page.screenshot({ path: "docs/screenshots/connection-editor.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({ path: "docs/screenshots/workspace.png" });
  expect(errors).toEqual([]);
});
test("queued uploads survive switching away from the session tab", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);
  await page.evaluate(() => ((window as any).__holdTransfer = true));
  const local = page.getByRole("listbox", { name: "Local directory" });
  await local.getByRole("option", { name: /alpha.txt/ }).click();
  await page.getByRole("button", { name: "Upload selection" }).click();
  await page.getByRole("button", { name: "Start upload" }).click();
  await expect(page.getByText("Transferring…")).toBeVisible();
  await local.getByRole("option", { name: /beta.txt/ }).click();
  await page.getByRole("button", { name: "Upload selection" }).click();
  await page.getByRole("button", { name: "Start upload" }).click();
  await expect(
    page.getByRole("button", { name: /Transfers.*1 queued/ }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .dblclick({ modifiers: ["Shift"] });
  await page
    .locator(".tab-bar .tab")
    .first()
    .getByRole("button", { name: "Integration server", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Transfers.*1 queued/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as any).__commands.filter(
          (c: any) => c.cmd === "transfer_batch",
        ).length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    (window as any).__holdTransfer = false;
    (window as any).__finishTransfer();
  });
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__commands.filter(
            (c: any) => c.cmd === "transfer_batch",
          ).length,
      ),
    )
    .toBe(2);
  await expect(page.getByText("Transfer complete")).toBeVisible();
});
test("native-style split panels, explicit host trust and independent tabs", async ({
  page,
}) => {
  await mockDesktop(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .dblclick();
  await page.getByRole("button", { name: "Connect to server" }).click();
  await expect(
    page.getByRole("heading", { name: "Verify server identity" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      (window as any).__commands.some((c: any) => c.cmd === "connect"),
    ),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Trust this key and connect" })
    .click();
  await expect(page.getByText("1 active sessions")).toBeVisible();
  const remote = page.getByRole("listbox", { name: "Remote directory" });
  await remote.getByRole("option", { name: /hello.txt/ }).click();
  await expect(
    page.getByRole("button", { name: "Download selection" }),
  ).toBeEnabled();
  await expect(
    page.getByRole("listbox", { name: "Local directory" }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/screenshots/connected-workspace-mock.png",
  });
  await page.getByRole("button", { name: "Local", exact: true }).click();
  await expect(remote).toBeHidden();
  await page.getByRole("button", { name: "Both", exact: true }).click();
  await expect(remote).toBeVisible();
  // Normal double-click focuses existing tab; Shift+double-click opens a second tab.
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .dblclick();
  await expect(
    page.getByRole("button", { name: "Close Integration server" }),
  ).toHaveCount(1);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .dblclick({ modifiers: ["Shift"] });
  await expect(
    page.getByRole("button", { name: "Close Integration server" }),
  ).toHaveCount(2);
  await page
    .getByRole("button", { name: "Close Integration server" })
    .last()
    .click();
  await expect(page.getByText("1 active sessions")).toBeVisible();
  expect(errors).toEqual([]);
});
test("Ctrl selection uploads a batch to the current remote directory", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);
  const local = page.getByRole("listbox", { name: "Local directory" });
  await local.getByRole("option", { name: /alpha.txt/ }).click();
  await local
    .getByRole("option", { name: /beta.txt/ })
    .click({ modifiers: ["Control"] });
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.getByRole("button", { name: "Upload selection" }).click();
  await expect(
    page.getByRole("heading", { name: "Upload 2 items" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start upload" }).click();
  await expect(page.getByText("Transfer complete")).toBeVisible();
  const request = await page.evaluate(
    () =>
      (window as any).__commands.find((c: any) => c.cmd === "transfer_batch")
        .args.request,
  );
  expect(request.sources).toEqual([
    "C:\\Users\\tester\\Desktop\\alpha.txt",
    "C:\\Users\\tester\\Desktop\\beta.txt",
  ]);
  expect(request.destination).toBe("/home/tester");
  expect(request.policy).toBe("replace");
});
test("Explorer native drop accepts multiple paths and targets the hovered folder", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);
  const target = page
    .getByRole("listbox", { name: "Remote directory" })
    .getByRole("option", { name: /uploads/ });
  const rect = (await target.boundingBox())!;
  await page.evaluate(
    ({ x, y }) =>
      (window as any).__drop(["C:\\drop\\one.txt", "C:\\drop\\folder"], x, y),
    { x: rect.x + 30, y: rect.y + rect.height / 2 },
  );
  await expect(
    page.getByRole("heading", { name: "Upload 2 items" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveValue(
    "/home/tester/uploads",
  );
  await page
    .getByRole("combobox", { name: "Conflict policy" })
    .selectOption("replace");
  await page.getByRole("button", { name: "Start upload" }).click();
  await expect(page.getByText("Transfer complete")).toBeVisible();
  const request = await page.evaluate(
    () =>
      (window as any).__commands.find((c: any) => c.cmd === "transfer_batch")
        .args.request,
  );
  expect(request.sources).toHaveLength(2);
  expect(request.destination).toBe("/home/tester/uploads");
  expect(request.policy).toBe("replace");
});
test("local multi-selection can be dragged directly into a remote folder", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);
  const local = page.getByRole("listbox", { name: "Local directory" });
  const first = local.getByRole("option", { name: /alpha.txt/ });
  await first.click();
  await local
    .getByRole("option", { name: /beta.txt/ })
    .click({ modifiers: ["Control"] });
  await first.dragTo(
    page
      .getByRole("listbox", { name: "Remote directory" })
      .getByRole("option", { name: /uploads/ }),
  );
  await expect(
    page.getByRole("heading", { name: "Upload 2 items" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveValue(
    "/home/tester/uploads",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});
test("remote multi-selection downloads into the visible local folder", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);
  const remote = page.getByRole("listbox", { name: "Remote directory" });
  await remote.getByRole("option", { name: /hello.txt/ }).click();
  await remote
    .getByRole("option", { name: /uploads/ })
    .click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "Download selection" }).click();
  await expect(
    page.getByRole("heading", { name: "Download 2 items" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveValue(
    "C:\\Users\\tester\\Desktop",
  );
  await page.getByRole("button", { name: "Start download" }).click();
  await expect(page.getByText("Transfer complete")).toBeVisible();
  const request = await page.evaluate(
    () =>
      (window as any).__commands.find((c: any) => c.cmd === "transfer_batch")
        .args.request,
  );
  expect(request.upload).toBe(false);
  expect(request.sources).toHaveLength(2);
});

test("file lists support type-to-select, F2 rename and Delete with explicit confirmation", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);
  const local = page.getByRole("listbox", { name: "Local directory" });
  await local.focus();
  await page.keyboard.press("b");
  await expect(local.getByRole("option", { name: /beta.txt/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("F2");
  const dialog = page.getByRole("dialog", { name: "File operation" });
  await dialog.getByLabel("Name", { exact: true }).fill("renamed.txt");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).__commands.find((c: any) => c.cmd === "local_action")
          .args,
    ),
  ).toEqual({
    action: "rename",
    paths: ["C:\\Users\\tester\\Desktop\\beta.txt"],
    name: "renamed.txt",
  });
  await local.getByRole("option", { name: /alpha.txt/ }).click();
  await local
    .getByRole("option", { name: /beta.txt/ })
    .click({ modifiers: ["Control"] });
  await page.keyboard.press("Delete");
  await expect(dialog.getByRole("heading")).toHaveText("Delete local items?");
  // Opening the confirmation must not delete anything.
  expect(
    await page.evaluate(
      () =>
        (window as any).__commands.filter((c: any) => c.cmd === "local_action")
          .length,
    ),
  ).toBe(1);
  await dialog.getByRole("button", { name: "Confirm" }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).__commands
          .filter((c: any) => c.cmd === "local_action")
          .at(-1).args,
    ),
  ).toEqual({
    action: "delete",
    paths: [
      "C:\\Users\\tester\\Desktop\\alpha.txt",
      "C:\\Users\\tester\\Desktop\\beta.txt",
    ],
    name: null,
  });
  const remote = page.getByRole("listbox", { name: "Remote directory" });
  await remote.focus();
  await page.keyboard.press("h");
  await expect(
    remote.getByRole("option", { name: /hello.txt/ }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Delete");
  await expect(dialog.getByRole("heading")).toHaveText("Delete remote item?");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).__commands.filter((c: any) => c.cmd === "remote_action")
          .length,
    ),
  ).toBe(0);
});

test("skipped uploads never claim files were transferred", async ({ page }) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);
  await page.evaluate(() => ((window as any).__skipAll = true));
  await page
    .getByRole("listbox", { name: "Local directory" })
    .getByRole("option", { name: /alpha.txt/ })
    .click();
  await page.getByRole("button", { name: "Upload selection" }).click();
  await expect(
    page.getByRole("combobox", { name: "Conflict policy" }),
  ).toHaveValue("replace");
  await page
    .getByRole("combobox", { name: "Conflict policy" })
    .selectOption("skip");
  await page.getByRole("button", { name: "Start upload" }).click();
  await expect(
    page.getByText("No files transferred — all items skipped"),
  ).toBeVisible();
  await expect(
    page.getByText("Transfer complete", { exact: false }),
  ).toHaveCount(0);
});

test("auto-connects on double-click when credential is saved and focuses existing tab", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.addInitScript(() => {
    (window as any).__savedCreds = ["test"];
    (window as any).__trustedFp = "SHA256:test-fingerprint";
  });
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .dblclick();
  await expect(page.getByText("1 active sessions")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Connect to server" }),
  ).toBeHidden();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .dblclick();
  await expect(
    page.getByRole("button", { name: "Close Integration server" }),
  ).toHaveCount(1);
});

test("remote files can be dragged to local folders and bulk-deleted via single batch", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);
  const remote = page.getByRole("listbox", { name: "Remote directory" });
  const local = page.getByRole("listbox", { name: "Local directory" });
  await remote
    .getByRole("option", { name: /hello.txt/ })
    .dragTo(local.getByRole("option", { name: /project/ }));
  await expect(
    page.getByRole("heading", { name: "Download 1 item", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveValue(
    "C:\\Users\\tester\\Desktop\\project",
  );
  await page.getByRole("button", { name: "Cancel", exact: true }).click();

  // Bulk delete two remote items uses remote_delete_batch and keeps failures inside modal.
  await page.evaluate(() => ((window as any).__partialDeleteFail = true));
  await remote.getByRole("option", { name: /hello.txt/ }).click();
  await remote
    .getByRole("option", { name: /uploads/ })
    .click({ modifiers: ["Control"] });
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("dialog", { name: "File operation" });
  await expect(dialog.getByRole("heading")).toHaveText("Delete remote items?");
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Permission denied");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(
    await page.evaluate(
      () =>
        (window as any).__commands.filter(
          (c: any) => c.cmd === "remote_delete_batch",
        ).length,
    ),
  ).toBe(1);
});

test("MobaXterm-style YAML editor opens on double-click, indents with Tab, saves cleanly, and supports split view", async ({
  page,
}) => {
  await mockDesktop(page);
  const dialogs: string[] = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    await d.accept();
  });
  await page.goto("/");
  await connect(page);
  const remote = page.getByRole("listbox", { name: "Remote directory" });
  await remote.getByRole("option", { name: /docker-compose\.yml/ }).dblclick();
  const editor = page.getByRole("region", {
    name: "Remote editor for docker-compose.yml",
  });
  await expect(editor).toBeVisible();
  await expect(editor.locator(".editor-badge").first()).toHaveText("YAML");

  // Unmodified file closes without any confirmation popup.
  await editor.getByRole("button", { name: "Close file" }).click();
  await expect(editor).toBeHidden();
  expect(dialogs).toEqual([]);

  // Reopen, toggle split view with terminal, type Tab & Ctrl+S.
  await remote.getByRole("option", { name: /docker-compose\.yml/ }).dblclick();
  await editor.getByRole("button", { name: /Split/ }).click();
  await expect(page.locator(".terminal-pane")).toBeVisible();
  const cmContent = editor.locator(".cm-content");
  await cmContent.click();
  await page.keyboard.press("Tab");
  await expect(editor.getByRole("button", { name: /Save/ })).toBeEnabled();
  await page.keyboard.press("Control+s");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__commands.filter(
            (c: any) => c.cmd === "write_remote",
          ).length,
      ),
    )
    .toBe(1);
  expect(dialogs).toEqual([]);
});

test("modals close on Escape without leaking errors and sidebar groups collapse", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.evaluate(() => ((window as any).__failSave = true));
  await page
    .getByRole("button", { name: "New Connection", exact: true })
    .click();
  await page.getByPlaceholder("Production server").fill("Test");
  await page.getByPlaceholder("192.168.1.10 or example.com").fill("1.2.3.4");
  await page.getByPlaceholder("root").fill("root");
  await page.getByRole("button", { name: "Save connection" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText(
    "Save validation failed",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator("main > .error")).toHaveCount(0);

  await page.getByRole("button", { name: /Development/ }).click();
  await expect(
    page
      .getByRole("navigation")
      .getByRole("button", { name: "Integration server" }),
  ).toBeHidden();
});

test("sidebar online indicator stays a 6px dot and remote folders trigger external drag past window edge", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await connect(page);

  const dot = page.locator(".connection-open > .status-dot.online");
  await expect(dot).toBeVisible();
  const dotBox = (await dot.boundingBox())!;
  expect(dotBox.width).toBeCloseTo(6, 1);
  expect(dotBox.height).toBeCloseTo(6, 1);

  const remote = page.getByRole("listbox", { name: "Remote directory" });
  const folderRow = remote.getByRole("option", { name: /uploads/ });
  const rowBox = (await folderRow.boundingBox())!;
  const winWidth = await page.evaluate(() => window.innerWidth);

  await page.mouse.move(rowBox.x + 20, rowBox.y + rowBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowBox.x + 40, rowBox.y + rowBox.height / 2, {
    steps: 4,
  });
  await page.mouse.move(winWidth + 10, rowBox.y + rowBox.height / 2, {
    steps: 4,
  });
  await page.mouse.up();

  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__commands.find(
          (c: any) => c.cmd === "start_external_drag",
        ),
      ),
    )
    .toBeTruthy();

  const dragCmd = await page.evaluate(() =>
    (window as any).__commands.find(
      (c: any) => c.cmd === "start_external_drag",
    ),
  );
  expect(dragCmd.args.paths).toEqual(["/home/tester/uploads"]);
  expect(dragCmd.args.roots).toEqual([
    { path: "/home/tester/uploads", directory: true, size: 0 },
  ]);

  await page.evaluate(() =>
    (window as any).__emit(
      "external-drag-error",
      "Simulated async drag failure",
    ),
  );
  await expect(page.locator(".file-error")).toContainText(
    "Simulated async drag failure",
  );
});
