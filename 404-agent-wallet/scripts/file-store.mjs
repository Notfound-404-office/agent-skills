import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";

export async function ensurePrivateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
    throw new Error("private directory must be a real directory with mode 0700");
  }
}

export async function writePrivate(path, contents, { exclusive = false } = {}) {
  await ensurePrivateDir(dirname(path));
  if (exclusive) {
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(contents); await handle.sync(); }
    finally { await handle.close(); }
    await chmod(path, 0o600);
    return;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error?.code === "ENOENT" && arguments.length > 1) return fallback; throw error; }
}

export async function readPrivateJson(path, label, fallback) {
  try { return JSON.parse(await requirePrivateFile(path, label)); }
  catch (error) { if (error?.code === "ENOENT" && arguments.length > 2) return fallback; throw error; }
}

export async function withFileLock(path, operation) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const localHost = hostname();
  let handle;
  for (;;) {
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, host: localHost, startedAt: new Date().toISOString(), command: process.argv.slice(1).join(" ") })}\n`);
      await handle.sync();
      break;
    }
    catch (error) {
      if (error?.code !== "EEXIST") {
        if (handle) { await handle.close().catch(() => undefined); await unlink(path).catch(() => undefined); }
        throw error;
      }
      let owner = null;
      try { owner = JSON.parse(await readFile(path, "utf8")); } catch {}
      const pid = Number(owner?.pid);
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); alive = true; } catch {} }
      const ownerHost = owner?.host;
      if (!alive && Number.isInteger(pid) && pid > 0 && (ownerHost === localHost || ownerHost === "unknown")) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      const details = owner ? ` (pid=${pid || "unknown"}, alive=${alive}, host=${ownerHost ?? "unknown"}, startedAt=${owner.startedAt ?? "unknown"}, command=${owner.command ?? "unknown"})` : " (owner metadata unavailable)";
      throw new Error(`another wallet operation is active; inspect the lock before retrying${details}`);
    }
  }
  try { return await operation(); }
  finally { await handle.close(); await unlink(path).catch(() => undefined); }
}

export async function requirePrivateFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error(`${label} must be a regular file with mode 0600`);
  return readFile(path, "utf8");
}

export class FileJournalStore {
  constructor(path) { this.path = path; }
  async readAll() {
    const value = await readPrivateJson(this.path, "transaction journal", []);
    if (!Array.isArray(value)) throw new Error("damaged transaction journal; saved payment outcome may be unknown");
    return value;
  }
  async put(record) {
    const values = await this.readAll();
    await writePrivate(this.path, `${JSON.stringify([...values.filter(value => value?.id !== record.id), record])}\n`);
  }
  async remove(id) {
    const values = await this.readAll();
    await writePrivate(this.path, `${JSON.stringify(values.filter(value => value?.id !== id))}\n`);
  }
}
