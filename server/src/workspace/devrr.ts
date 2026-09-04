/**
 * devrr — project governance for a workspace.
 *
 * A workspace in Studio is a checkout somebody is working in. devrr governs a
 * checkout: it keeps an Obsidian-compatible vault of the project's intent —
 * research, concept, plan, design, requirements, a task DAG — behind four
 * procedure layers (guardrail, policy, checkpoint, gate) and a hash-chained
 * audit record of every decision.
 *
 * WHY SHELL OUT RATHER THAN IMPORT. devrr is a separate tool with its own
 * release cycle, and a workspace may be governed by a different version of it
 * than Studio was built against. Running the CLI means the answer always comes
 * from the devrr that project actually uses, and Studio carries no copy of the
 * rules to drift from. It also keeps the governance where it belongs: every
 * refusal in here is devrr's refusal, not a second implementation of one.
 *
 * WHAT THIS MODULE WILL NOT DO. It never edits a note, never writes
 * frontmatter, and never invents an actor. A mutation carries the handle the
 * caller supplied and devrr decides whether that is enough — approving a gate
 * without `--by` is refused by devrr, not by a check here that could be
 * forgotten.
 *
 * SSH connections are reported as unsupported rather than silently answering
 * about the wrong machine.
 */

import { runBinaryProcessWithTimeout } from "./process";

/**
 * Run a binary IN a directory.
 *
 * `runBinaryProcessWithTimeout` cannot set a working directory, which is why
 * the first version of this file passed `--vault <checkout>/vault` — and that
 * hardcoded devrr's most common layout as its only one. devrr resolves a vault
 * itself: `vault/` first, then a single `*-vault/` directory. A real workspace
 * on this machine (`synapse-dispatch`, whose vault is `reslax-vault/`) would
 * have been reported as ungoverned. Let devrr answer the question it already
 * knows how to answer.
 */
async function runIn(cwd: string, argv: string[], timeoutMs: number) {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const output = Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([code, stdout, stderr]) => {
    if (timer) clearTimeout(timer);
    return { code, stdout, stderr };
  });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
      reject(new Error(`${argv[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([output, timeout]);
}

const DEVRR_TIMEOUT_MS = 20_000;

/** Handles devrr will accept in a permanent record. */
const HANDLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Note paths a caller may name. Containment is devrr's job too, but a path
 *  with a `..` in it never needs to reach a process argument to be refused. */
const NOTE_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/;

export type DevrrRun = {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
};

export type DevrrState =
  | { available: false; reason: "not-installed" | "no-vault" | "remote"; detail: string }
  | {
      available: true;
      checkout_path: string;
      status: unknown;
      check: unknown;
      dag: unknown;
      errors: string[];
    };

function assertNote(value: unknown, what: string): string {
  const note = String(value ?? "").trim();
  if (!note) throw new Error(`${what} requires a note`);
  if (note.includes("..") || !NOTE_RE.test(note)) {
    throw new Error(`${what}: '${note}' is not a note path inside the vault`);
  }
  return note;
}

function assertHandle(value: unknown, what: string): string {
  const handle = String(value ?? "").trim();
  if (!handle) throw new Error(`${what} requires --by <handle>: a decision names who made it`);
  if (!HANDLE_RE.test(handle)) {
    throw new Error(
      `${what}: '${handle}' is not a legal handle — lowercase letters, digits and single hyphens. ` +
        `It is written into a permanent record.`,
    );
  }
  return handle;
}

export function createDevrrService(deps: {
  getWorkspace: (id: string) => Promise<any>;
  explorerRoot: (id: string, workspace: any) => Promise<string>;
  sshHost: () => string | null;
}) {
  const { getWorkspace, explorerRoot, sshHost } = deps;

  async function run(cwd: string, args: string[]): Promise<DevrrRun> {
    // No `--vault`: devrr finds its own, and a workspace whose vault is named
    // `<project>-vault` is governed just as much as one with `vault/`.
    const result = await runIn(cwd, ["devrr", ...args], DEVRR_TIMEOUT_MS);
    return {
      // devrr exits 1 for findings and 2 for usage errors. Findings are an
      // ANSWER, not a failure — a vault with problems is exactly what the panel
      // exists to show — so only a usage error or a crash is `ok: false`.
      ok: result.code === 0 || result.code === 1,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async function json(cwd: string, args: string[]): Promise<{ value: unknown; error: string | null }> {
    let result: DevrrRun;
    try {
      result = await run(cwd, [...args, "--json"]);
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : String(e) };
    }
    if (!result.ok) {
      return { value: null, error: (result.stderr || result.stdout).trim().slice(0, 400) };
    }
    try {
      return { value: JSON.parse(result.stdout), error: null };
    } catch {
      // devrr printed something that is not JSON. Say so rather than showing an
      // empty panel that looks like a clean project.
      return { value: null, error: `devrr ${args.join(" ")} did not return JSON` };
    }
  }

  async function rootFor(params: Record<string, unknown>, what: string) {
    const workspaceId = String(params.workspace_id ?? "");
    if (!workspaceId) throw new Error(`${what} requires workspace_id`);
    const workspace = await getWorkspace(workspaceId);
    const checkoutPath = await explorerRoot(workspaceId, workspace);
    if (!checkoutPath) throw new Error("workspace has no directory path");
    return { workspaceId, checkoutPath };
  }

  /**
   * Everything the panel shows, in one call.
   *
   * Three separate round trips over a websocket for three views of the same
   * vault would let the panel render a status from one moment beside a graph
   * from another, and nothing would say they disagreed.
   */
  async function state(params: Record<string, unknown>): Promise<DevrrState> {
    const host = sshHost();
    if (host) {
      return {
        available: false,
        reason: "remote",
        detail: `This workspace is on ${host}. devrr runs against a local checkout; remote vaults are not supported yet.`,
      };
    }
    const { checkoutPath } = await rootFor(params, "devrr.state");

    try {
      const probe = await runBinaryProcessWithTimeout(["devrr", "--help"], 5_000);
      if (probe.code !== 0 && probe.code !== 2) throw new Error(String(probe.code));
    } catch {
      return {
        available: false,
        reason: "not-installed",
        detail:
          "`devrr` is not on this machine's PATH. Install it, then reopen this tab — Studio deliberately carries no copy of the rules.",
      };
    }

    const statusResult = await json(checkoutPath, ["status"]);
    if (statusResult.error && /no vault at/i.test(statusResult.error)) {
      return {
        available: false,
        reason: "no-vault",
        detail: `No devrr vault in ${checkoutPath}. Run \`devrr init\` there to start governing this project.`,
      };
    }

    const [checkResult, dagResult] = await Promise.all([
      json(checkoutPath, ["check"]),
      json(checkoutPath, ["dag", "json"]),
    ]);

    // Every failure is reported, never swallowed. A panel that hides the half
    // it could not read looks like a project with nothing wrong in it.
    const errors = [statusResult.error, checkResult.error, dagResult.error].filter(
      (e): e is string => Boolean(e),
    );

    return {
      available: true,
      checkout_path: checkoutPath,
      status: statusResult.value,
      check: checkResult.value,
      dag: dagResult.value,
      errors,
    };
  }

  /**
   * Record a gate decision a human has stated.
   *
   * The handle is validated here only so a malformed one never becomes a
   * process argument; whether a gate MAY be approved at all — whether its
   * checkpoints are discharged — is devrr's decision, and this returns its
   * refusal verbatim.
   */
  async function gate(params: Record<string, unknown>) {
    const { checkoutPath } = await rootFor(params, "devrr.gate");
    const note = assertNote(params.note, "devrr.gate");
    const decision = String(params.decision ?? "");
    if (decision !== "approve" && decision !== "reject") {
      throw new Error("devrr.gate: decision is 'approve' or 'reject'");
    }
    const by = assertHandle(params.by, "devrr.gate");
    const result = await run(checkoutPath, ["gate", note, decision, "--by", by]);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 500));
    return { note, decision, by, output: result.stdout.trim() };
  }

  /** Clear, waive or fail one checkpoint. `cleared` needs evidence; devrr says so. */
  async function checkpoint(params: Record<string, unknown>) {
    const { checkoutPath } = await rootFor(params, "devrr.checkpoint");
    const note = assertNote(params.note, "devrr.checkpoint");
    const id = String(params.id ?? "").trim();
    if (!id) throw new Error("devrr.checkpoint requires id");
    const state_ = String(params.state ?? "").trim();
    if (!state_) throw new Error("devrr.checkpoint requires state");
    const evidence = Array.isArray(params.evidence) ? params.evidence.map((e) => String(e)) : [];
    const by = params.by ? assertHandle(params.by, "devrr.checkpoint") : null;
    const actor = params.actor ? assertHandle(params.actor, "devrr.checkpoint") : null;

    const args = ["checkpoint", note, id, state_];
    for (const e of evidence) args.push("--evidence", e);
    if (by) args.push("--by", by);
    // Clearing a checkpoint is agent-writable, so devrr asks for no handle —
    // and the record then said `agent` for something a person clicked.
    if (actor) args.push("--actor", actor);
    const result = await run(checkoutPath, args);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 500));
    return { note, id, state: state_, output: result.stdout.trim() };
  }

  /** Move a ticket or requirement. `done` needs evidence; devrr says so. */
  async function work(params: Record<string, unknown>) {
    const { checkoutPath } = await rootFor(params, "devrr.work");
    const note = assertNote(params.note, "devrr.work");
    const status = String(params.status ?? "").trim();
    if (!status) throw new Error("devrr.work requires status");
    const evidence = Array.isArray(params.evidence) ? params.evidence.map((e) => String(e)) : [];
    const by = params.by ? assertHandle(params.by, "devrr.work") : null;
    const actor = params.actor ? assertHandle(params.actor, "devrr.work") : null;

    const args = ["work", note, status];
    for (const e of evidence) args.push("--evidence", e);
    if (by) args.push("--by", by);
    if (actor) args.push("--actor", actor);
    const result = await run(checkoutPath, args);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(0, 500));
    return { note, status, output: result.stdout.trim() };
  }

  return { state, gate, checkpoint, work };
}
