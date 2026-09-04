import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  browseRoots,
  createDirectoryHandlers,
  createLocalDirectory,
  expandHomePath,
  isBrowsable,
  listLocalDirectories,
  parentDirectory,
  parseRemoteDirectoryList,
  sanitizeDirectoryName,
} from "./directories";

/**
 * A temp directory the browser is allowed to reach.
 *
 * `$TMPDIR` is outside `$HOME`, and browsing is now confined to `$HOME` plus
 * whatever an operator declares. These tests declare it — the same escape
 * hatch a person with code on another volume uses — rather than the fixture
 * quietly being exempt from the rule it is testing around.
 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "herdr-gui-test-"));
  const previous = process.env.HERDR_GUI_BROWSE_ROOTS;
  process.env.HERDR_GUI_BROWSE_ROOTS = await realpath(dir);
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HERDR_GUI_BROWSE_ROOTS;
    else process.env.HERDR_GUI_BROWSE_ROOTS = previous;
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
      // The temp dir IS the declared root here, so there is nowhere up to go.
      // Offering its real parent would put an "up" control in the UI that
      // always fails.
      expect(visible.parent).toBeNull();
      expect(parentDirectory(visible.path)).not.toBeNull();
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

// ---------------------------------------------------------------------------
// Containment. `directory.list` and `directory.create` are this fork's own
// RPCs and accepted any absolute path: they enumerated and created anywhere the
// server process could reach.
// ---------------------------------------------------------------------------

describe("browse roots", () => {
  test("home is a root, and paths under it are browsable", () => {
    const roots = ["/Users/someone"];
    expect(isBrowsable("/Users/someone", roots)).toBe(true);
    expect(isBrowsable("/Users/someone/code/app", roots)).toBe(true);
  });

  test("a sibling that merely shares a prefix is not inside", () => {
    // `/Users/someone-else` starts with `/Users/someone` as a STRING and is a
    // different person's home.
    expect(isBrowsable("/Users/someone-else", ["/Users/someone"])).toBe(false);
    expect(isBrowsable("/Users/someoneelse/x", ["/Users/someone"])).toBe(false);
  });

  test("everything outside every root is refused", () => {
    const roots = ["/Users/someone"];
    expect(isBrowsable("/etc", roots)).toBe(false);
    expect(isBrowsable("/", roots)).toBe(false);
    expect(isBrowsable("/Users", roots)).toBe(false);
  });

  test("an operator can name another root explicitly", () => {
    const previous = process.env.HERDR_GUI_BROWSE_ROOTS;
    process.env.HERDR_GUI_BROWSE_ROOTS = "/Volumes/Code:~/scratch";
    try {
      const roots = browseRoots("/Users/someone");
      expect(roots).toContain("/Users/someone");
      expect(roots).toContain("/Volumes/Code");
      expect(roots).toContain("/Users/someone/scratch");
    } finally {
      if (previous === undefined) delete process.env.HERDR_GUI_BROWSE_ROOTS;
      else process.env.HERDR_GUI_BROWSE_ROOTS = previous;
    }
  });

  test("listing refuses a path outside the roots", async () => {
    await expect(listLocalDirectories("/etc", false)).rejects.toThrow(
      /outside the directories this server may browse/,
    );
  });

  test("creating refuses a parent outside the roots", async () => {
    await expect(createLocalDirectory("/etc", "pwned")).rejects.toThrow(
      /outside the directories this server may browse/,
    );
  });

  test("listing home still works, and offers no way up out of it", async () => {
    const result = await listLocalDirectories("~", false);
    expect(result.path).toBe(await realpath(homedir()));
    // The true parent of home exists; offering it would put an "up" control in
    // the UI that always fails.
    expect(result.parent).toBeNull();
  });
});
