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
    });
    Object.assign(window, {
      __commands: commands,
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
          if (cmd === "probe_host")
            return { fingerprint: "SHA256:test-fingerprint", previous: null };
          if (cmd === "connect") return `session-${++seq}`;
          if (cmd === "remote_home") return "/home/tester";
          if (cmd === "list_remote")
            return [
              entry("uploads", `${args.path}/uploads`, true),
              entry("hello.txt", `${args.path}/hello.txt`),
            ];
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
          if (cmd === "transfer_batch") {
            const result = {
              completedBytes: 2400,
              totalBytes: 2400,
              completedFiles: 2,
              totalFiles: 2,
              skippedFiles: 0,
              current: "",
              status: "completed",
            };
            args.progress.onmessage({
              ...result,
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
          if (cmd === "save_connection") {
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
      "Choose a server in the sidebar, then double-click to open a session.",
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
    .dblclick();
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
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .dblclick();
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
  expect(request.policy).toBe("skip");
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
