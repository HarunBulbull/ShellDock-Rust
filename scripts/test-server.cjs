// Disposable SSH/SFTP fixture: loopback only, ephemeral host key and in-memory files.
// Never use this fixture as a real SSH server.
const { Server, utils } = require("ssh2");
const { generateKeyPairSync } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { STATUS_CODE, OPEN_MODE } = utils.sftp;
const keyObject = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey;
const key = keyObject.export({ type: "pkcs1", format: "pem" });
const publicKey = utils.parseKey(key);
const modernHost = utils.generateKeyPairSync("ed25519");
if (process.argv[2]) {
  writeFileSync(
    process.argv[2],
    keyObject.export({
      type: "pkcs1",
      format: "pem",
      cipher: "aes-256-cbc",
      passphrase: "fixture-passphrase",
    }),
    { mode: 0o600 },
  );
}
if (process.argv[3])
  writeFileSync(process.argv[3], modernHost.private, { mode: 0o600 });
const allowedClientKeys = [publicKey, utils.parseKey(modernHost.private)];
const files = new Map([["/hello.txt", Buffer.from("Hello from SFTP\n")]]);
const directories = new Set(["/"]);
// ssh2's server does not implement DH group exchange. Advertise only implemented
// modern exchanges so this fixture does not negotiate an unusable server method.
const server = new Server(
  {
    hostKeys: [modernHost.private, key],
    algorithms: {
      kex: [
        "curve25519-sha256",
        "ecdh-sha2-nistp256",
        "diffie-hellman-group14-sha256",
        "diffie-hellman-group16-sha512",
        "diffie-hellman-group18-sha512",
      ],
    },
  },
  (client) => {
    client.on("error", (error) => {
      if (process.env.SHELLDOCK_FIXTURE_DEBUG) console.error(error.message);
    });
    client.on("authentication", (ctx) => {
      if (ctx.username !== "tester") return ctx.reject();
      if (ctx.method === "password" && ctx.password === "fixture-password")
        return ctx.accept();
      if (
        ctx.method === "publickey" &&
        allowedClientKeys.some(
          (key) =>
            ctx.key.data.equals(key.getPublicSSH()) &&
            (!ctx.signature ||
              key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true),
        )
      )
        return ctx.accept();
      ctx.reject();
    });
    client.on("ready", () =>
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (accept) => accept());
        session.on("window-change", (accept) => {
          if (accept) accept();
        });
        session.on("shell", (accept) => {
          const stream = accept();
          stream.write("ShellDock fixture ready\r\n");
          stream.on("data", (data) => {
            stream.write(data);
            if (data.includes(Buffer.from("exit"))) {
              stream.exit(0);
              stream.end();
            }
          });
        });
        session.on("sftp", (accept) => {
          const sftp = accept(),
            handles = new Map();
          sftp.on("end", () => sftp.end());
          let seq = 0;
          const stat = (data) => ({
            mode: 0o100644,
            uid: 0,
            gid: 0,
            size: data.length,
            atime: 0,
            mtime: 0,
          });
          sftp.on("REALPATH", (id, path) =>
            sftp.name(id, [
              {
                filename: path === "." ? "/" : path,
                longname: path,
                attrs: {
                  mode: 0o40755,
                  uid: 0,
                  gid: 0,
                  size: 0,
                  atime: 0,
                  mtime: 0,
                },
              },
            ]),
          );
          const directoryStat = {
            mode: 0o40755,
            uid: 0,
            gid: 0,
            size: 0,
            atime: 0,
            mtime: 0,
          };
          sftp.on("MKDIR", (id, path) => {
            if (files.has(path) || directories.has(path))
              return sftp.status(id, STATUS_CODE.FAILURE);
            directories.add(path);
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on("STAT", (id, path) =>
            directories.has(path)
              ? sftp.attrs(id, directoryStat)
              : files.has(path)
                ? sftp.attrs(id, stat(files.get(path)))
                : sftp.status(id, STATUS_CODE.NO_SUCH_FILE),
          );
          sftp.on("LSTAT", (id, path) =>
            directories.has(path)
              ? sftp.attrs(id, directoryStat)
              : files.has(path)
                ? sftp.attrs(id, stat(files.get(path)))
                : sftp.status(id, STATUS_CODE.NO_SUCH_FILE),
          );
          sftp.on("OPEN", (id, path, flags) => {
            if (flags & OPEN_MODE.EXCL && files.has(path))
              return sftp.status(id, STATUS_CODE.FAILURE);
            if (!files.has(path) && !(flags & OPEN_MODE.CREAT))
              return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            if (!files.has(path) || flags & OPEN_MODE.TRUNC)
              files.set(path, Buffer.alloc(0));
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(++seq);
            handles.set(seq, { path });
            sftp.handle(id, handle);
          });
          sftp.on("FSTAT", (id, handle) => {
            const h = handles.get(handle.readUInt32BE());
            if (h) sftp.attrs(id, stat(files.get(h.path)));
            else sftp.status(id, STATUS_CODE.FAILURE);
          });
          sftp.on("READ", (id, handle, offset, length) => {
            const h = handles.get(handle.readUInt32BE());
            const data = files.get(h?.path);
            if (!data) return sftp.status(id, STATUS_CODE.FAILURE);
            if (offset >= data.length) return sftp.status(id, STATUS_CODE.EOF);
            // Simulate a server that acknowledges writes but returns old/wrong bytes.
            if (h.path === "/__corrupt_upload.txt")
              return sftp.data(
                id,
                Buffer.alloc(Math.min(length, data.length - offset), 120),
              );
            sftp.data(id, data.subarray(offset, offset + length));
          });
          sftp.on("WRITE", (id, handle, offset, data) => {
            const h = handles.get(handle.readUInt32BE());
            if (!h) return sftp.status(id, STATUS_CODE.FAILURE);
            const before = files.get(h.path);
            const next = Buffer.alloc(
              Math.max(before.length, offset + data.length),
            );
            before.copy(next);
            data.copy(next, offset);
            files.set(h.path, next);
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on("CLOSE", (id, handle) => {
            handles.delete(handle.readUInt32BE());
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on("OPENDIR", (id, path) => {
            if (!directories.has(path))
              return sftp.status(id, STATUS_CODE.NO_SUCH_FILE);
            const handle = Buffer.alloc(4);
            handle.writeUInt32BE(++seq);
            handles.set(seq, { directory: true, read: false, path });
            sftp.handle(id, handle);
          });
          sftp.on("READDIR", (id, handle) => {
            const h = handles.get(handle.readUInt32BE());
            if (!h || h.read) return sftp.status(id, STATUS_CODE.EOF);
            h.read = true;
            const prefix = h.path === "/" ? "/" : h.path + "/";
            const children = [...files.keys(), ...directories].filter(
              (path) =>
                path.startsWith(prefix) &&
                path !== h.path &&
                !path.slice(prefix.length).includes("/"),
            );
            if (!children.length) return sftp.status(id, STATUS_CODE.EOF);
            sftp.name(
              id,
              children.map((path) => ({
                filename: path.slice(prefix.length),
                longname: path,
                attrs: directories.has(path)
                  ? directoryStat
                  : stat(files.get(path)),
              })),
            );
          });
          sftp.on("REMOVE", (id, path) => {
            files.delete(path);
            sftp.status(id, STATUS_CODE.OK);
          });
          sftp.on("RENAME", (id, from, to) => {
            // Fault injection verifies rollback after a staged replacement fails.
            if (to === "/__reject_commit.txt" && from.endsWith(".part"))
              return sftp.status(id, STATUS_CODE.FAILURE);
            if (!files.has(from) || files.has(to))
              return sftp.status(id, STATUS_CODE.FAILURE);
            files.set(to, files.get(from));
            files.delete(from);
            sftp.status(id, STATUS_CODE.OK);
          });
        });
      }),
    );
  },
);
server.listen(0, "127.0.0.1", () =>
  process.stdout.write(`${server.address().port}\n`),
);
