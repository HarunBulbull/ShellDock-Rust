import { test, expect } from "@playwright/test";

test("browser preview clearly separates desktop capabilities", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "A place for every connection." }),
  ).toBeVisible();
  await expect(page.getByText("Browser preview ·")).toBeVisible();
  await page.getByRole("button", { name: "Add a server" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save connection" }),
  ).toBeDisabled();
  await page.screenshot({ path: "docs/screenshots/connection-editor.png" });
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.screenshot({ path: "docs/screenshots/workspace.png" });
  expect(errors).toEqual([]);
});

test("saved servers open independent tabs and require a host trust decision", async ({
  page,
}) => {
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
    const commands: string[] = [];
    const callbacks = new Map<number, (data: unknown) => void>();
    let seq = 0;
    Object.assign(window, {
      __commands: commands,
      __TAURI_INTERNALS__: {
        transformCallback: (cb: (data: unknown) => void) => {
          callbacks.set(++seq, cb);
          return seq;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        invoke: async (cmd: string, args: Record<string, any>) => {
          commands.push(cmd);
          if (cmd === "list_connections") return saved;
          if (cmd === "probe_host")
            return { fingerprint: "SHA256:test-fingerprint", previous: null };
          if (cmd === "connect") return "test-session";
          if (cmd === "remote_home") return "/home/tester";
          if (cmd === "list_remote")
            return [
              {
                name: "hello.txt",
                path: "/home/tester/hello.txt",
                size: 12,
                directory: false,
                symlink: false,
                modified: 0,
              },
            ];
          if (cmd === "save_connection") {
            saved.push(args.connection);
            return;
          }
        },
      },
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.stack ?? e.message));
  await page.goto("/");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .click();
  await page.getByRole("button", { name: "Connect to server" }).click();
  await expect(
    page.getByRole("heading", { name: "Verify server identity" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__commands.includes("connect")),
  ).toBe(false);
  await page
    .getByRole("button", { name: "Trust this key and connect" })
    .click();
  await expect(page.getByText("1 active sessions")).toBeVisible();
  await expect(page.getByRole("listitem")).toContainText("hello.txt");
  await page.getByRole("listitem").click();
  await expect(
    page.getByRole("button", { name: "Download file", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: "docs/screenshots/connected-workspace-mock.png",
  });
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Integration server" })
    .click();
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
