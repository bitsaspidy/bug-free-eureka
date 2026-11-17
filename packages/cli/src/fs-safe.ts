import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { UsageError } from "./errors.js";

/** Largest config or evidence file the CLI reads. */
export const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** POSIX path of `abs` relative to `root`, for reports and messages. */
export function toPosixRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function code(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

/** Real path of `abs`, or of its nearest existing ancestor joined with the missing tail. */
async function realOrAncestor(abs: string): Promise<string> {
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    try {
      return join(await realpath(current), ...tail.reverse());
    } catch (err) {
      if (code(err) !== "ENOENT" && code(err) !== "ENOTDIR") throw err;
      const parent = dirname(current);
      if (parent === current) throw err;
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Resolves a user-supplied path against the project root and refuses anything that
 * escapes it, lexically or through symlinks. `label` names the flag or config key in
 * error messages; the path itself is never echoed.
 */
export async function resolveInside(
  root: string,
  userPath: string,
  label: string,
): Promise<string> {
  if (userPath.length === 0 || userPath.includes("\0")) {
    throw new UsageError(`${label}: expected a file path`);
  }
  const abs = resolve(root, userPath);
  if (!isInside(root, abs) || !isInside(root, await realOrAncestor(abs))) {
    throw new UsageError(`${label}: path is outside the project directory`);
  }
  return abs;
}

export async function exists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch (err) {
    if (code(err) === "ENOENT") return false;
    throw err;
  }
}

/** Reads a regular file of at most MAX_INPUT_BYTES as UTF-8. Never follows into FIFOs or devices. */
export async function readSmallFile(abs: string, label: string): Promise<string> {
  let info;
  try {
    info = await stat(abs);
  } catch (err) {
    if (code(err) === "ENOENT") throw new UsageError(`${label}: file not found`);
    throw new UsageError(`${label}: file cannot be read`);
  }
  if (!info.isFile()) throw new UsageError(`${label}: not a regular file`);
  if (info.size > MAX_INPUT_BYTES) throw new UsageError(`${label}: file is larger than 8 MiB`);
  // O_NONBLOCK keeps a file swapped for a FIFO after the stat from blocking the open.
  const handle = await open(abs, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)).catch(() => {
    throw new UsageError(`${label}: file cannot be read`);
  });
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new UsageError(`${label}: not a regular file`);
    if (opened.size > MAX_INPUT_BYTES) throw new UsageError(`${label}: file is larger than 8 MiB`);
    const buf = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Parses JSON without echoing any of the input in the error (Node's message quotes it). */
export function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
  } catch {
    throw new UsageError(`${label}: not valid JSON`);
  }
}

/**
 * Atomically writes `content` to `abs` (already contained by resolveInside): parent
 * directories are created, the data goes to a temp file in the same directory, then it
 * is renamed over the target. Readers never see a half-written file.
 */
export async function writeAtomic(
  root: string,
  abs: string,
  content: string,
  label: string,
): Promise<void> {
  const dir = dirname(abs);
  await mkdir(dir, { recursive: true }).catch(() => {
    throw new UsageError(`${label}: cannot create the parent directory`);
  });
  // Re-check after mkdir: a directory on the way may be a symlink created meanwhile.
  if (!isInside(root, await realpath(dir))) {
    throw new UsageError(`${label}: path is outside the project directory`);
  }
  try {
    if ((await lstat(abs)).isDirectory()) throw new UsageError(`${label}: is a directory`);
  } catch (err) {
    if (err instanceof UsageError) throw err;
    if (code(err) !== "ENOENT") throw new UsageError(`${label}: cannot be written`);
  }
  const tmp = join(dir, `.${basename(abs)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const handle = await open(tmp, "wx", 0o644);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, abs);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    if (err instanceof UsageError) throw err;
    throw new UsageError(`${label}: cannot be written`);
  }
}
