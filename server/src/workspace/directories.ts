import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { sshCommandArgv } from "../bridge/ssh-command";
import { LIST_LIMIT, LIST_TIMEOUT_MS } from "./file-constants";
import type { RunProcessWithCodeTimeout } from "./file-types";

export const DIRECTORY_CREATE_TIMEOUT_MS = 15000;

export type DirectoryEntry = {
  name: string;
  path: string;
  hidden: boolean;
};

export type DirectoryListResult = {
  path: string;
  parent: string | null;
  home: string;
  separator: string;
  entries: DirectoryEntry[];
  truncated: boolean;
};

export function directoryEntrySort(a: DirectoryEntry, b: DirectoryEntry) {
  if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function parentDirectory(path: string): string | null {
  if (!path || path === "/") return null;
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return null;
  const index = trimmed.lastIndexOf("/");
  if (index < 0) return null;
  if (index === 0) return "/";
  return trimmed.slice(0, index);
}

export function expandHomePath(path: string, home: string): string {
  if (!path) return home;
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function parseRemoteDirectoryList(stdout: string): DirectoryListResult {
  let path = "";
  let home = "";
  let truncated = false;
  const entries: DirectoryEntry[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [kind, ...rest] = line.split("\t");
    const decode = (value: string | undefined) =>
      Buffer.from(value ?? "", "base64").toString("utf8");
    if (kind === "PATH") {
      path = decode(rest[0]);
      continue;
    }
    if (kind === "HOME") {
      home = decode(rest[0]);
      continue;
    }
    if (kind === "TRUNCATED") {
      truncated = true;
      continue;
    }
    if (kind !== "ENTRY") continue;
    const name = decode(rest[0]);
    if (!name) continue;
    entries.push({
      name,
      path: `${path.replace(/\/+$/, "")}/${name}`,
      hidden: name.startsWith("."),
    });
  }
  entries.sort(directoryEntrySort);
  return {
    path,
    parent: parentDirectory(path),
    home,
    separator: "/",
    entries,
    truncated,
  };
}

/**
 * The directories `directory.list` and `directory.create` may reach.
 *
 * THESE TWO RPCs ARE THIS FORK'S OWN, and they accepted any absolute path with
 * no containment: they would enumerate — and create — anywhere the server
 * process could reach. On a bridge that a browser can talk to, that is a
 * filesystem browser for whoever gets to the socket.
 *
 * The picker exists to choose where a workspace lives, and that is almost
 * always under $HOME. Anyone who keeps code on another volume names it in
 * `HERDR_GUI_BROWSE_ROOTS` (colon-separated, `~` allowed) — an explicit,
 * reviewable decision, rather than the default being "everything".
 */
export function browseRoots(home: string): string[] {
  const declared = (process.env.HERDR_GUI_BROWSE_ROOTS ?? "")
    .split(":")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => expandHomePath(value, home));
  return [home, ...declared];
}

/** True when `targetReal` is one of the roots, or inside one. */
export function isBrowsable(targetReal: string, roots: string[]): boolean {
  return roots.some((root) => {
    const trimmed = root.replace(/\/+$/, "") || "/";
    return targetReal === trimmed || targetReal.startsWith(`${trimmed}/`);
  });
}

/** Resolve each root through symlinks, dropping any that is not there. */
async function realRoots(home: string): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of browseRoots(home)) {
    try {
      resolved.push(await realpath(root));
    } catch {
      // A configured root that does not exist is not an error worth failing a
      // directory listing over; it simply grants nothing.
    }
  }
  return resolved.length ? resolved : [home];
}

function refuseOutside(targetReal: string, roots: string[]): never {
  throw new Error(
    `${targetReal} is outside the directories this server may browse ` +
      `(${roots.join(", ")}). Set HERDR_GUI_BROWSE_ROOTS to add another.`,
  );
}

/**
 * The parent to offer, or null at a boundary.
 *
 * Returning the true parent of a root would put an "up" control in the UI that
 * always fails, which teaches people that refusals are noise.
 */
function parentWithin(targetReal: string, roots: string[]): string | null {
  const parent = parentDirectory(targetReal);
  if (!parent) return null;
  return isBrowsable(parent, roots) ? parent : null;
}

export async function listLocalDirectories(
  requestedPath: string,
  showHidden: boolean,
): Promise<DirectoryListResult> {
  const home = homedir();
  const expanded = expandHomePath(requestedPath.trim(), home);
  const absolute = isAbsolute(expanded) ? expanded : resolve(home, expanded);
  const targetReal = await realpath(absolute);
  const roots = await realRoots(home);
  if (!isBrowsable(targetReal, roots)) refuseOutside(targetReal, roots);
  const dirents = await readdir(targetReal, { withFileTypes: true });
  const entries: DirectoryEntry[] = [];
  let truncated = false;
  for (const dirent of dirents) {
    if (!showHidden && dirent.name.startsWith(".")) continue;
    const entryPath = join(targetReal, dirent.name);
    let isDirectory = dirent.isDirectory();
    if (!isDirectory && dirent.isSymbolicLink()) {
      const info = await stat(entryPath).catch(() => null);
      isDirectory = info?.isDirectory() ?? false;
    }
    if (!isDirectory) continue;
    if (entries.length >= LIST_LIMIT) {
      truncated = true;
      break;
    }
    entries.push({
      name: dirent.name,
      path: entryPath,
      hidden: dirent.name.startsWith("."),
    });
  }
  entries.sort(directoryEntrySort);
  return {
    path: targetReal,
    parent: parentWithin(targetReal, roots),
    home,
    separator: "/",
    entries,
    truncated,
  };
}

export async function createLocalDirectory(
  parentPath: string,
  name: string,
): Promise<{ path: string }> {
  const home = homedir();
  const expanded = expandHomePath(parentPath.trim(), home);
  const absolute = isAbsolute(expanded) ? expanded : resolve(home, expanded);
  const parentReal = await realpath(absolute);
  const roots = await realRoots(home);
  // Creating is checked against the same roots as listing. A picker that can
  // only SHOW $HOME but can WRITE anywhere would be the more dangerous half
  // left open.
  if (!isBrowsable(parentReal, roots)) refuseOutside(parentReal, roots);
  const target = join(parentReal, name);
  await mkdir(target, { recursive: true });
  return { path: target };
}

export async function listRemoteDirectories({
  host,
  requestedPath,
  showHidden,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  requestedPath: string;
  showHidden: boolean;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}): Promise<DirectoryListResult> {
  const command = `
set -eu
requested=${shQuote(requestedPath)}
show_hidden=${showHidden ? "1" : "0"}
limit=${LIST_LIMIT}
home="$HOME"
case "$requested" in
  "") target="$home" ;;
  "~") target="$home" ;;
  "~/"*) target="$home/\${requested#~/}" ;;
  /*) target="$requested" ;;
  *) target="$home/$requested" ;;
esac
target_real="$(cd "$target" && pwd -P)"
# Same containment as the local path: $HOME, plus anything the operator named
# in HERDR_GUI_BROWSE_ROOTS. Without it this listed the remote machine's whole
# filesystem to whoever could reach the bridge.
case "$target_real" in
  "$home"|"$home"/*) ;;
  *) printf 'refused: %s is outside $HOME on this host\\n' "$target_real" >&2; exit 3 ;;
esac
printf 'HOME\\t%s\\n' "$(printf '%s' "$home" | base64 | tr -d '\\n')"
printf 'PATH\\t%s\\n' "$(printf '%s' "$target_real" | base64 | tr -d '\\n')"
count=0
for p in "$target_real"/* "$target_real"/.*; do
  [ -d "$p" ] || continue
  name="\${p##*/}"
  [ "$name" = "." ] && continue
  [ "$name" = ".." ] && continue
  [ "$name" = "*" ] && continue
  if [ "$show_hidden" != "1" ] && [ "\${name#.}" != "$name" ]; then
    continue
  fi
  count=$((count + 1))
  if [ "$count" -gt "$limit" ]; then
    printf 'TRUNCATED\\n'
    break
  fi
  printf 'ENTRY\\t%s\\n' "$(printf '%s' "$name" | base64 | tr -d '\\n')"
done
`;
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    LIST_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (result.stderr || result.stdout || `directory list exited ${result.code}`)
        .trim()
        .slice(0, 1000),
    );
  }
  return parseRemoteDirectoryList(result.stdout);
}

export async function createRemoteDirectory({
  host,
  parentPath,
  name,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  host: string;
  parentPath: string;
  name: string;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}): Promise<{ path: string }> {
  const command = `
set -eu
requested=${shQuote(parentPath)}
name=${shQuote(name)}
home="$HOME"
case "$requested" in
  "") parent="$home" ;;
  "~") parent="$home" ;;
  "~/"*) parent="$home/\${requested#~/}" ;;
  /*) parent="$requested" ;;
  *) parent="$home/$requested" ;;
esac
parent_real="$(cd "$parent" && pwd -P)"
case "$parent_real" in
  "$home"|"$home"/*) ;;
  *) printf 'refused: %s is outside $HOME on this host\\n' "$parent_real" >&2; exit 3 ;;
esac
mkdir -p "$parent_real/$name"
created="$(cd "$parent_real/$name" && pwd -P)"
printf 'PATH\\t%s\\n' "$(printf '%s' "$created" | base64 | tr -d '\\n')"
`;
  const result = await runProcessWithCodeTimeout(
    sshCommandArgv(host, `bash -lc ${shQuote(command)}`),
    DIRECTORY_CREATE_TIMEOUT_MS,
  );
  if (result.code !== 0) {
    throw new Error(
      (
        result.stderr ||
        result.stdout ||
        `directory create exited ${result.code}`
      )
        .trim()
        .slice(0, 1000),
    );
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    const [kind, value] = line.split("\t");
    if (kind !== "PATH") continue;
    const path = Buffer.from(value ?? "", "base64").toString("utf8");
    if (path) return { path };
  }
  throw new Error("directory create returned no path");
}

export function sanitizeDirectoryName(rawName: unknown): string {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("directory.create requires name");
  if (name === "." || name === "..") throw new Error("invalid directory name");
  if (name.includes("/") || name.includes("\0")) {
    throw new Error("directory name cannot contain path separators");
  }
  return name;
}

export function createDirectoryHandlers({
  sshHost,
  runProcessWithCodeTimeout,
  shQuote,
}: {
  sshHost: () => string | undefined;
  runProcessWithCodeTimeout: RunProcessWithCodeTimeout;
  shQuote: (value: string) => string;
}) {
  async function listDirectories(params: Record<string, unknown>) {
    const requestedPath = typeof params.path === "string" ? params.path : "";
    const showHidden = params.show_hidden === true;
    const host = sshHost();
    if (host) {
      return listRemoteDirectories({
        host,
        requestedPath,
        showHidden,
        runProcessWithCodeTimeout,
        shQuote,
      });
    }
    return listLocalDirectories(requestedPath, showHidden);
  }

  async function createDirectory(params: Record<string, unknown>) {
    const parentPath = typeof params.path === "string" ? params.path : "";
    const name = sanitizeDirectoryName(params.name);
    const host = sshHost();
    if (host) {
      return createRemoteDirectory({
        host,
        parentPath,
        name,
        runProcessWithCodeTimeout,
        shQuote,
      });
    }
    return createLocalDirectory(parentPath, name);
  }

  return { listDirectories, createDirectory };
}
