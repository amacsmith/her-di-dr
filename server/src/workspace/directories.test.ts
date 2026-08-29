import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDirectoryHandlers,
  createLocalDirectory,
  expandHomePath,
  listLocalDirectories,
  parentDirectory,
  parseRemoteDirectoryList,
  sanitizeDirectoryName,
} from "./directories";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-gui-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("directory path helpers", () => {
  test("resolves parents up to the filesystem root", () => {
    expect(parentDirectory("/Users/mac/code")).toBe("/Users/mac");
    expect(parentDirectory("/Users")).toBe("/");
    expect(parentDirectory("/")).toBeNull();
    expect(parentDirectory("")).toBeNull();
  });

  test("expands home shorthand only at the start of the path", () => {
    expect(expandHomePath("~", "/home/mac")).toBe("/home/mac");
    expect(expandHomePath("~/code", "/home/mac")).toBe("/home/mac/code");
    expect(expandHomePath("", "/home/mac")).toBe("/home/mac");
    expect(expandHomePath("/tmp/~", "/home/mac")).toBe("/tmp/~");
  });

  test("rejects directory names that escape the parent", () => {
    expect(sanitizeDirectoryName(" build ")).toBe("build");
    expect(() => sanitizeDirectoryName("")).toThrow();
    expect(() => sanitizeDirectoryName("..")).toThrow();
    expect(() => sanitizeDirectoryName("a/b")).toThrow();
  });
});

describe("local directory browsing", () => {
  test("lists only directories, hidden ones gated by the flag", async () => {
    await withTempDir(async (root) => {
      await mkdir(join(root, "src"));
      await mkdir(join(root, ".git"));
      await writeFile(join(root, "README.md"), "hello");

      const visible = await listLocalDirectories(root, false);
      expect(visible.entries.map((entry) => entry.name)).toEqual(["src"]);
      expect(visible.parent).toBe(parentDirectory(visible.path));
      expect(visible.separator).toBe("/");

      const hidden = await listLocalDirectories(root, true);
      expect(hidden.entries.map((entry) => entry.name)).toEqual([
        "src",
        ".git",
      ]);
    });
  });

  test("creates nested folders and returns the created path", async () => {
    await withTempDir(async (root) => {
      const created = await createLocalDirectory(root, "new-project");
      expect(created.path.endsWith("new-project")).toBe(true);
      const listed = await listLocalDirectories(root, false);
      expect(listed.entries.map((entry) => entry.name)).toEqual([
        "new-project",
      ]);
    });
  });
});

describe("remote directory listing", () => {
  test("parses the ssh listing protocol", () => {
    const stdout = [
      `HOME\t${encode("/home/mac")}`,
      `PATH\t${encode("/home/mac/code")}`,
      `ENTRY\t${encode("web")}`,
      `ENTRY\t${encode(".cache")}`,
      "TRUNCATED",
      "",
    ].join("\n");

    const parsed = parseRemoteDirectoryList(stdout);
    expect(parsed.path).toBe("/home/mac/code");
    expect(parsed.home).toBe("/home/mac");
    expect(parsed.parent).toBe("/home/mac");
    expect(parsed.truncated).toBe(true);
    expect(parsed.entries).toEqual([
      { name: "web", path: "/home/mac/code/web", hidden: false },
      { name: ".cache", path: "/home/mac/code/.cache", hidden: true },
    ]);
  });

  test("routes over ssh when the connection has a host", async () => {
    const calls: string[][] = [];
    const handlers = createDirectoryHandlers({
      sshHost: () => "build-box",
      runProcessWithCodeTimeout: async (argv: string[]) => {
        calls.push(argv);
        return {
          code: 0,
          stdout: [
            `HOME\t${encode("/home/mac")}`,
            `PATH\t${encode("/srv")}`,
            `ENTRY\t${encode("apps")}`,
          ].join("\n"),
          stderr: "",
        };
      },
      shQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
    });

    const result = await handlers.listDirectories({ path: "/srv" });
    expect(result.path).toBe("/srv");
    expect(result.entries).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.join(" ")).toContain("build-box");
  });
});
