import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_FILE = new URL("../sdk-release.json", import.meta.url);
const BUNDLED_SDK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../sdk");

function runtimeError(code, message, cause) {
  const error = new Error(`${code}: ${message}`, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

async function exists(path) {
  try { await access(path, constants.F_OK); return true; } catch { return false; }
}

function validateRelease(repository, revision) {
  if (typeof repository !== "string" || typeof revision !== "string"
    || repository.trim() === "" || revision.trim() === "") {
    throw runtimeError("SDK_RELEASE_NOT_CONFIGURED", "Set repository and revision in sdk-release.json before publishing this skill");
  }
  let url;
  try { url = new URL(repository); } catch (cause) {
    throw runtimeError("SDK_RELEASE_INVALID", "The SDK repository must be a public HTTPS Git URL", cause);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
    || !url.hostname || url.pathname === "/") {
    throw runtimeError("SDK_RELEASE_INVALID", "The SDK repository must be a public HTTPS Git URL without credentials, query, or fragment");
  }
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw runtimeError("SDK_RELEASE_INVALID", "The SDK revision must be a full 40-character Git commit hash");
  }
  return { repository: url.href, revision: revision.toLowerCase() };
}

export async function loadSdkRelease(options = {}) {
  const env = options.env ?? process.env;
  if (Object.hasOwn(env, "PROTOCOL404_SDK_REPOSITORY") || Object.hasOwn(env, "PROTOCOL404_SDK_REVISION")) {
    return validateRelease(env.PROTOCOL404_SDK_REPOSITORY, env.PROTOCOL404_SDK_REVISION);
  }
  if (options.release) return validateRelease(options.release.repository, options.release.revision);
  try {
    const release = JSON.parse(await readFile(options.releaseFile ?? RELEASE_FILE, "utf8"));
    return validateRelease(release?.repository, release?.revision);
  } catch (cause) {
    if (["SDK_RELEASE_NOT_CONFIGURED", "SDK_RELEASE_INVALID"].includes(cause?.code)) throw cause;
    throw runtimeError("SDK_RELEASE_INVALID", "sdk-release.json must contain a repository URL and full commit revision", cause);
  }
}

export async function frontendAt(root) {
  for (const candidate of [join(root, "frontend"), join(root, "dist", "protocol404", "frontend")]) {
    try {
      await Promise.all([
        access(join(candidate, "src", "flows", "session.ts"), constants.R_OK),
        access(join(candidate, "package.json"), constants.R_OK),
        access(join(candidate, "package-lock.json"), constants.R_OK),
      ]);
      return candidate;
    } catch {}
  }
  throw runtimeError("SDK_ROOT_INVALID", `Protocol 404 SDK markers are missing under ${root}`);
}

export async function relayerAt(root) {
  for (const candidate of [join(root, "relayer"), join(root, "dist", "protocol404", "relayer")]) {
    try {
      await Promise.all([
        access(join(candidate, "src", "validators.ts"), constants.R_OK),
        access(join(candidate, "package.json"), constants.R_OK),
        access(join(candidate, "package-lock.json"), constants.R_OK),
      ]);
      return candidate;
    } catch {}
  }
  throw runtimeError("SDK_ROOT_INVALID", `Protocol 404 relayer markers are missing under ${root}`);
}

async function assertSdkRoot(root) {
  const canonical = await realpath(resolve(root));
  await Promise.all([frontendAt(canonical), relayerAt(canonical)]);
  return canonical;
}

export async function assertSetupRoot(root) {
  const canonical = await assertSdkRoot(root);
  const frontend = await frontendAt(canonical);
  const manifestPath = join(canonical, ".proof-assets", "manifest.json");
  let manifest;
  try {
    await Promise.all([
      access(join(canonical, "scripts", "proof-assets.py"), constants.R_OK),
      access(manifestPath, constants.R_OK),
    ]);
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!Array.isArray(manifest) || manifest.length === 0
      || manifest.some(asset => !Array.isArray(asset?.paths) || asset.paths.length === 0
        || asset.paths.some(path => typeof path !== "string"))) throw new Error("invalid proof asset manifest");
  } catch (cause) {
    throw runtimeError("SDK_SETUP_INCOMPLETE", `Proof asset sources are missing under ${canonical}`, cause);
  }
  const publicRoot = join(frontend, "public");
  const hasFrontendDestination = asset => asset.paths.some(path => {
    const destination = resolve(canonical, path);
    const fromPublic = relative(publicRoot, destination);
    return fromPublic !== "" && !fromPublic.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && fromPublic !== ".." && !isAbsolute(fromPublic);
  });
  if (manifest.some(asset => !hasFrontendDestination(asset))) {
    throw runtimeError("SDK_ASSET_LAYOUT_INVALID", `Proof asset destinations do not match the selected frontend: ${frontend}`);
  }
  return canonical;
}

export function sdkCacheRoot(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const paths = platform === "win32" ? win32 : { join, resolve };
  let base;
  if (env.XDG_CACHE_HOME) base = paths.resolve(env.XDG_CACHE_HOME);
  else if (platform === "win32" && env.LOCALAPPDATA) base = paths.resolve(env.LOCALAPPDATA);
  else if (platform === "darwin") base = paths.join(home, "Library", "Caches");
  else base = paths.join(home, ".cache");
  const revision = options.revision ?? env.PROTOCOL404_SDK_REVISION;
  if (!/^[0-9a-f]{40}$/i.test(revision ?? "")) {
    throw runtimeError("SDK_RELEASE_INVALID", "A full SDK revision is required to select the cache");
  }
  return paths.join(base, "protocol404", "sdk", revision.toLowerCase());
}

export async function resolveSdkRoot(root, options = {}) {
  const env = options.env ?? process.env;
  if (root !== undefined) {
    if (typeof root !== "string" || root.trim() === "") throw runtimeError("SDK_ROOT_INVALID", "--root must be a non-empty SDK directory");
    try { return await assertSdkRoot(root); }
    catch (cause) { throw runtimeError("SDK_ROOT_INVALID", `--root does not contain a compatible Protocol 404 SDK: ${resolve(root)}`, cause); }
  }
  if (Object.hasOwn(env, "PROTOCOL404_ROOT")) {
    if (typeof env.PROTOCOL404_ROOT !== "string" || env.PROTOCOL404_ROOT.trim() === "") {
      throw runtimeError("SDK_ROOT_INVALID", "PROTOCOL404_ROOT must be a non-empty SDK directory");
    }
    try { return await assertSdkRoot(env.PROTOCOL404_ROOT); }
    catch (cause) { throw runtimeError("SDK_ROOT_INVALID", `PROTOCOL404_ROOT does not contain a compatible Protocol 404 SDK: ${resolve(env.PROTOCOL404_ROOT)}`, cause); }
  }

  if (await exists(BUNDLED_SDK_ROOT)) {
    try { return await assertSetupRoot(BUNDLED_SDK_ROOT); }
    catch (cause) {
      throw runtimeError("SDK_BUNDLED_INVALID", `The bundled Protocol 404 SDK is incomplete: ${BUNDLED_SDK_ROOT}`, cause);
    }
  }

  const release = await loadSdkRelease(options);
  const cached = sdkCacheRoot({ ...options, revision: release.revision });
  if (await exists(cached)) {
    try { return await assertSdkRoot(cached); }
    catch (cause) { throw runtimeError("SDK_CACHE_INVALID", `The Protocol 404 SDK cache is incomplete: ${cached}`, cause); }
  }
  throw runtimeError("SDK_ROOT_NOT_FOUND", "Protocol 404 SDK is not installed; run this skill's setup.mjs once");
}

export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, options);
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`${command} exited with ${signal ?? code}`)));
  });
}

export async function bootstrapSdk(options = {}) {
  const release = await loadSdkRelease(options);
  const target = sdkCacheRoot({ ...options, revision: release.revision });
  if (await exists(target)) {
    try { return await assertSetupRoot(target); }
    catch (cause) { throw runtimeError("SDK_CACHE_INVALID", `Refusing to replace the existing Protocol 404 SDK cache: ${target}`, cause); }
  }

  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(join(parent, `.${release.revision}.tmp-`));
  const run = options.run ?? runCommand;
  const gitOptions = { cwd: temporary, env: { ...(options.env ?? process.env), GIT_TERMINAL_PROMPT: "0" }, stdio: "ignore" };
  try {
    await run("git", ["init", "--quiet"], gitOptions);
    await run("git", ["remote", "add", "origin", release.repository], gitOptions);
    await run("git", ["fetch", "--quiet", "--depth", "1", "origin", release.revision], gitOptions);
    await run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], gitOptions);
    await assertSetupRoot(temporary);
    await rename(temporary, target);
    return await assertSetupRoot(target);
  } catch (cause) {
    await rm(temporary, { recursive: true, force: true });
    if (await exists(target)) {
      throw runtimeError("SDK_CACHE_OCCUPIED", `Another setup created the SDK cache while this setup was running: ${target}`, cause);
    }
    throw runtimeError("SDK_BOOTSTRAP_FAILED", "Could not install the pinned Protocol 404 SDK; check Git/network access and retry setup", cause);
  }
}
