/**
 * devrr service tests — against the real CLI and a real vault.
 *
 * Nothing here is stubbed except the workspace lookup, which is the one thing
 * that needs a running herdr daemon. The vault, the CLI, the JSON and the
 * refusals are real: a test that mocked `devrr` would prove this module works
 * against a mock of devrr, which is not the claim being made.
 *
 * Every test skips itself, loudly, when `devrr` is not installed — a green tick
 * for a suite that silently ran nothing is worse than a red one.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDevrrService } from "./devrr";
import { runBinaryProcessWithTimeout } from "./process";

const GOVERNED_CHECKOUT = join(process.env.HOME ?? "", "zdev", "devrr");

async function devrrInstalled(): Promise<boolean> {
  try {
    const probe = await runBinaryProcessWithTimeout(["devrr", "--help"], 5_000);
    return probe.code === 0 || probe.code === 2;
  } catch {
    return false;
  }
}

function serviceFor(checkoutPath: string, host: string | null = null) {
  return createDevrrService({
    getWorkspace: async (id: string) => ({ workspace_id: id }),
    explorerRoot: async () => checkoutPath,
    sshHost: () => host,
  });
}

describe("devrr service", () => {
  test("reads a real governed checkout", async () => {
    if (!(await devrrInstalled())) {
      console.warn("SKIPPED: devrr is not on PATH");
      return;
    }
    const service = serviceFor(GOVERNED_CHECKOUT);
    const state = await service.state({ workspace_id: "w1" });
    if (!state.available && state.reason === "no-vault") {
      console.warn(`SKIPPED: no vault at ${GOVERNED_CHECKOUT}`);
      return;
    }
    expect(state.available).toBe(true);
    if (!state.available) return;

    // Everything the panel renders must actually be there.
    expect(state.checkout_path).toBe(GOVERNED_CHECKOUT);
    expect(state.errors).toEqual([]);
    expect(Array.isArray((state.status as any)?.flows)).toBe(true);
    expect(typeof (state.check as any)?.clean).toBe("boolean");
    expect(typeof (state.dag as any)?.acyclic).toBe("boolean");
    expect(typeof (state.dag as any)?.counts?.nodes).toBe("number");
  });

  test("a checkout with no vault is reported as such, not as a clean project", async () => {
    if (!(await devrrInstalled())) {
      console.warn("SKIPPED: devrr is not on PATH");
      return;
    }
    const empty = mkdtempSync(join(tmpdir(), "devrr-novault-"));
    const state = await serviceFor(empty).state({ workspace_id: "w1" });
    expect(state.available).toBe(false);
    if (state.available) return;
    expect(state.reason).toBe("no-vault");
    // The difference between "governed and fine" and "not governed" is the
    // whole point of the panel; collapsing them would make the tab a lie.
    expect(state.detail).toContain("devrr init");
  });

  test("an ssh workspace says so rather than answering about this machine", async () => {
    const state = await serviceFor("/anywhere", "build-box").state({ workspace_id: "w1" });
    expect(state.available).toBe(false);
    if (state.available) return;
    expect(state.reason).toBe("remote");
    expect(state.detail).toContain("build-box");
  });

  test("a note path that climbs out of the vault never reaches a process", async () => {
    const service = serviceFor(GOVERNED_CHECKOUT);
    await expect(
      service.gate({ workspace_id: "w1", note: "../../etc/passwd", decision: "approve", by: "mac" }),
    ).rejects.toThrow(/not a note path/);
  });

  test("a gate decision without a handle is refused before it is run", async () => {
    const service = serviceFor(GOVERNED_CHECKOUT);
    await expect(
      service.gate({ workspace_id: "w1", note: "intake/idea", decision: "approve" }),
    ).rejects.toThrow(/names who made it/);
    await expect(
      service.gate({ workspace_id: "w1", note: "intake/idea", decision: "approve", by: "Mac Smith" }),
    ).rejects.toThrow(/legal handle/);
  });

  test("only approve and reject are decisions", async () => {
    const service = serviceFor(GOVERNED_CHECKOUT);
    await expect(
      service.gate({ workspace_id: "w1", note: "intake/idea", decision: "maybe", by: "mac" }),
    ).rejects.toThrow(/approve/);
  });

  test("devrr's own refusal is surfaced verbatim, not paraphrased", async () => {
    if (!(await devrrInstalled())) {
      console.warn("SKIPPED: devrr is not on PATH");
      return;
    }
    // A scratch checkout, governed for real. Asserting against the developer's
    // own vault would either mutate it or depend on what happens to be in it
    // today; neither is a test.
    const checkout = mkdtempSync(join(tmpdir(), "devrr-scratch-"));
    await runBinaryProcessWithTimeout(["git", "-C", checkout, "init", "-q"], 10_000);
    await runBinaryProcessWithTimeout(
      ["devrr", "init", "--vault", join(checkout, "vault")],
      20_000,
    );
    await runBinaryProcessWithTimeout(
      ["devrr", "new", "requirement", "--title", "A need", "--vault", join(checkout, "vault")],
      20_000,
    );
    await runBinaryProcessWithTimeout(
      [
        "devrr",
        "decompose",
        "requirements/a-need",
        "--title",
        "Do the thing",
        "--vault",
        join(checkout, "vault"),
      ],
      20_000,
    );

    const service = serviceFor(checkout);

    // Marking work done with a SENTENCE for evidence is refused by devrr. The
    // panel's usefulness rests on the reason reaching the person, so assert the
    // reason rather than merely that something failed.
    let sentence = "";
    try {
      await service.work({
        workspace_id: "w1",
        note: "tickets/do-the-thing",
        status: "done",
        evidence: ["the tests pass"],
      });
    } catch (e) {
      sentence = e instanceof Error ? e.message : String(e);
    }
    expect(sentence).toContain("evidence");
    expect(sentence).toContain("the tests pass");

    // And with no evidence at all.
    let none = "";
    try {
      await service.work({ workspace_id: "w1", note: "tickets/do-the-thing", status: "done" });
    } catch (e) {
      none = e instanceof Error ? e.message : String(e);
    }
    expect(none).toContain("--evidence");

    // Real evidence closes it, and the panel sees devrr's own confirmation.
    const done = await service.work({
      workspace_id: "w1",
      note: "tickets/do-the-thing",
      status: "done",
      evidence: ["vault/schema/config.md"],
    });
    expect(done.status).toBe("done");
    expect(done.output).toContain("done");
  });

  test("a gate is refused while its checkpoints are outstanding", async () => {
    if (!(await devrrInstalled())) {
      console.warn("SKIPPED: devrr is not on PATH");
      return;
    }
    const checkout = mkdtempSync(join(tmpdir(), "devrr-gate-"));
    await runBinaryProcessWithTimeout(["git", "-C", checkout, "init", "-q"], 10_000);
    const vault = join(checkout, "vault");
    await runBinaryProcessWithTimeout(["devrr", "init", "--vault", vault], 20_000);
    await runBinaryProcessWithTimeout(
      ["devrr", "new", "intake", "--title", "An idea", "--vault", vault],
      20_000,
    );
    await runBinaryProcessWithTimeout(
      ["devrr", "advance", "intake/an-idea", "--vault", vault],
      20_000,
    );

    const service = serviceFor(checkout);
    let refusal = "";
    try {
      await service.gate({
        workspace_id: "w1",
        note: "intake/an-idea",
        decision: "approve",
        by: "mac",
      });
    } catch (e) {
      refusal = e instanceof Error ? e.message : String(e);
    }
    // This is the sentence the panel puts in front of a person, and it has to
    // say WHICH obligations are outstanding.
    expect(refusal).toContain("outstanding");
    expect(refusal).toContain("research-brief-written");

    // Saying no needs no proof, and must always be available.
    const rejected = await service.gate({
      workspace_id: "w1",
      note: "intake/an-idea",
      decision: "reject",
      by: "mac",
    });
    expect(rejected.decision).toBe("reject");
  });
});
