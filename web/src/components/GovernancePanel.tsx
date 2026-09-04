/**
 * GovernancePanel — what this workspace's project owes, and who owes it.
 *
 * A workspace in Studio is a checkout somebody is working in. devrr governs a
 * checkout: it keeps the project's intent in a plain-Markdown vault behind four
 * layers — guardrails that nobody may clear, policy changed only by a commit,
 * checkpoints an agent may discharge with evidence, and gates only a human may
 * decide — and records every decision in a hash-chained log.
 *
 * This panel shows the part of that a person needs while they are working:
 * which flows are waiting on a gate, what each one owes before it can be
 * approved, whether the vault and the task graph are clean, and what work is
 * unblocked right now.
 *
 * IT DECIDES NOTHING. Approve and Reject send the handle the user typed to
 * devrr and show devrr's answer. When devrr refuses — a checkpoint outstanding,
 * evidence that is a sentence rather than a file — the refusal is displayed as
 * written, because the reason is the useful part and paraphrasing it here would
 * make Studio a second, quieter implementation of the rules.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import type { ConnectionClient } from "../api";

type GateNeed = {
  id: string;
  state: string;
  at: string | null;
  actor: string | null;
};

type Flow = {
  id: string;
  stage: string | null;
  terminal?: boolean;
  track: string | null;
  cycle: number;
  gate: string | null;
  prompt: string | null;
  source: string | null;
  needs: GateNeed[];
  outstanding: string[];
  history: string[];
};

type CheckFinding = {
  id: string;
  note?: string | null;
  folder?: string | null;
  severity?: string;
  value?: string;
  why?: string;
};

type DevrrState =
  | { available: false; reason: string; detail: string }
  | {
      available: true;
      checkout_path: string;
      status: { mode?: string; flows?: Flow[] } | null;
      check: {
        clean?: boolean;
        notes?: number;
        errors?: CheckFinding[];
        warnings?: CheckFinding[];
      } | null;
      dag: {
        acyclic?: boolean;
        counts?: { nodes?: number; requirements?: number; tasks?: number; edges?: number };
        ready?: string[];
        critical_path?: { length?: number; path?: string[] };
      } | null;
      errors: string[];
    };

const HANDLE_KEY = "devrr.handle";

function readHandle(): string {
  try {
    return window.localStorage.getItem(HANDLE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function GovernancePanel({
  client,
  workspaceId,
  active,
}: {
  client: ConnectionClient | null;
  workspaceId: string | null;
  active: boolean;
}) {
  const [state, setState] = useState<DevrrState | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [handle, setHandle] = useState<string>(() => readHandle());
  // ONE form open at a time. Five owed checkpoints each with a permanently
  // visible evidence field is a wall of inputs nobody reads; and every one of
  // these writes to an append-only record, so the deliberate click that opens
  // the form is worth keeping.
  const [acting, setActing] = useState<
    | { kind: "checkpoint"; note: string; id: string }
    | { kind: "work"; note: string }
    | null
  >(null);
  const [evidence, setEvidence] = useState("");

  const load = useCallback(async () => {
    if (!client || !workspaceId) return;
    setLoading(true);
    setError(null);
    try {
      const result = (await client.call("devrr.state", {
        workspace_id: workspaceId,
      })) as DevrrState;
      setState(result);
    } catch (e) {
      // The panel says what went wrong rather than rendering an empty vault,
      // which would read as a project with nothing outstanding.
      setState(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    if (active) void load();
  }, [active, load]);

  const decide = useCallback(
    async (note: string, decision: "approve" | "reject") => {
      if (!client || !workspaceId) return;
      const who = handle.trim();
      if (!who) {
        setError("A gate decision names who made it. Enter a handle first.");
        return;
      }
      setBusy(`${note}:${decision}`);
      setError(null);
      try {
        await client.call("devrr.gate", {
          workspace_id: workspaceId,
          note,
          decision,
          by: who,
        });
        try {
          window.localStorage.setItem(HANDLE_KEY, who);
        } catch {
          /* a remembered handle is a convenience, never a requirement */
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [client, workspaceId, handle, load],
  );

  /**
   * Discharge a checkpoint, or close a piece of work.
   *
   * Both send the evidence the user typed and show devrr's answer. Neither
   * checks the evidence here: "a repo-relative path to a file" is devrr's rule,
   * and a copy of it in this panel would be a second rule that could disagree
   * with the first — which is exactly how the rule went wrong twice before.
   */
  const submit = useCallback(async () => {
    if (!client || !workspaceId || !acting) return;
    const cited = evidence.trim();
    const who = handle.trim();
    setBusy("submit");
    setError(null);
    try {
      // `actor` as well as `by`. Clearing a checkpoint is agent-writable, so
      // devrr does not demand a handle for it — and without one the record
      // read `agent` for something a PERSON had just clicked. The chain should
      // say who was at the keyboard.
      const common = {
        workspace_id: workspaceId,
        note: acting.note,
        evidence: cited ? [cited] : [],
        by: who || undefined,
        actor: who || undefined,
      };
      if (acting.kind === "checkpoint") {
        await client.call("devrr.checkpoint", { ...common, id: acting.id, state: "cleared" });
      } else {
        await client.call("devrr.work", { ...common, status: "done" });
      }
      setActing(null);
      setEvidence("");
      await load();
    } catch (e) {
      // devrr's refusal, verbatim. The form stays open with what was typed,
      // because the reason usually names the thing to change.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [client, workspaceId, acting, evidence, handle, load]);

  const actionForm = (label: string) => (
    <div className="devrr-action">
      <label>
        {label}
        <input
          type="text"
          value={evidence}
          spellCheck={false}
          autoFocus
          placeholder="src/thing.mjs — a file, not a sentence"
          onChange={(e) => setEvidence(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            if (e.key === "Escape") {
              setActing(null);
              setEvidence("");
            }
          }}
        />
      </label>
      <button type="button" className="devrr-approve" disabled={busy !== null} onClick={() => void submit()}>
        Record
      </button>
      <button
        type="button"
        onClick={() => {
          setActing(null);
          setEvidence("");
        }}
      >
        Cancel
      </button>
    </div>
  );

  const flows = useMemo(
    () => (state?.available ? (state.status?.flows ?? []) : []),
    [state],
  );
  const openGates = useMemo(() => flows.filter((f) => f.gate === "open"), [flows]);

  // Errors first, then warnings, capped — with the count of what was dropped.
  const FINDING_LIMIT = 12;
  const allFindings = useMemo(() => {
    if (!state?.available) return [];
    const errors = (state.check?.errors ?? []).map((f) => ({ ...f, severity: f.severity ?? "error" }));
    const warnings = (state.check?.warnings ?? []).map((f) => ({ ...f, severity: "warn" }));
    return [...errors, ...warnings];
  }, [state]);
  const findingsToShow = allFindings.slice(0, FINDING_LIMIT);
  const moreFindings = allFindings.length - findingsToShow.length;

  if (!workspaceId) {
    return <div className="devrr-empty">Select a workspace to see its governance.</div>;
  }

  if (loading && !state) {
    return (
      <div className="devrr-empty">
        <Loader2 size={16} className="devrr-spin" /> Reading the vault…
      </div>
    );
  }

  if (state && !state.available) {
    return (
      <div className="devrr-empty">
        <CircleSlash size={16} />
        <p>{state.detail}</p>
        <button type="button" onClick={() => void load()}>
          Check again
        </button>
      </div>
    );
  }

  return (
    <div className="devrr-panel">
      <div className="devrr-toolbar">
        <label className="devrr-handle">
          acting as
          <input
            type="text"
            value={handle}
            spellCheck={false}
            placeholder="your handle"
            aria-label="Your devrr handle"
            onChange={(e) => setHandle(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="devrr-refresh"
          onClick={() => void load()}
          disabled={loading}
          title="Re-read the vault from disk"
        >
          <RefreshCw size={14} className={loading ? "devrr-spin" : ""} /> Refresh
        </button>
      </div>

      {error ? (
        // Persistent, and dismissed only by the person who read it. devrr's
        // refusals are the useful part of using devrr.
        <div className="devrr-error" role="alert">
          <AlertTriangle size={14} />
          <pre>{error}</pre>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ) : null}

      {state?.available && state.errors.length > 0
        ? state.errors.map((e) => (
            <div className="devrr-error" role="alert" key={e}>
              <AlertTriangle size={14} />
              <pre>{e}</pre>
            </div>
          ))
        : null}

      {state?.available ? (
        <div className="devrr-summary">
          <span className={state.check?.clean ? "devrr-pill ok" : "devrr-pill bad"}>
            {state.check?.clean
              ? `vault clean · ${state.check?.notes ?? 0} notes`
              : `${state.check?.errors?.length ?? 0} error(s)`}
          </span>
          {/* Warnings were not shown at all, and the ones that matter most here
              are warnings by design: evidence that is derived, or that git does
              not track, is exactly the "passes on my machine" class. A panel
              that shows only errors hides the findings whose whole point is
              that nothing is failing yet. */}
          {(state.check?.warnings?.length ?? 0) > 0 ? (
            <span className="devrr-pill warn">{state.check?.warnings?.length} warning(s)</span>
          ) : null}
          <span className={state.dag?.acyclic === false ? "devrr-pill bad" : "devrr-pill ok"}>
            {state.dag?.acyclic === false ? "graph has a cycle" : "graph acyclic"}
          </span>
          <span className="devrr-pill">
            {state.dag?.counts?.requirements ?? 0} requirements · {state.dag?.counts?.tasks ?? 0} tasks
          </span>
          <span className={openGates.length ? "devrr-pill warn" : "devrr-pill"}>
            {openGates.length} gate(s) open
          </span>
        </div>
      ) : null}

      <h4 className="devrr-heading">Gates</h4>
      {openGates.length === 0 ? (
        <p className="devrr-quiet">
          <CheckCircle2 size={14} /> Nothing is waiting on a human.
        </p>
      ) : (
        openGates.map((flow) => {
          // Approving is refused while anything is outstanding — by devrr. The
          // button is disabled to say so before the click, never instead of it:
          // the same call is refused server-side if this check is wrong.
          const blocked = flow.outstanding.length > 0;
          return (
            <div className="devrr-gate" key={flow.id}>
              <div className="devrr-gate-head">
                <code>{flow.id}</code>
                <span className="devrr-quiet">
                  stage {flow.stage} · track {flow.track} · cycle {flow.cycle}
                </span>
              </div>
              {flow.prompt ? (
                <p className="devrr-prompt">{String(flow.prompt).replace(/^"|"$/g, "")}</p>
              ) : null}
              {flow.needs.length ? (
                <ul className="devrr-needs">
                  {flow.needs.map((need) => {
                    const met = need.state === "cleared" || need.state === "waived";
                    return (
                      <li key={need.id} className={met ? "met" : "owed"}>
                        <code>{need.id}</code> <span>{need.state}</span>
                        {met ? null : (
                          <button
                            type="button"
                            className="devrr-inline"
                            title="Discharge this with evidence"
                            onClick={() => {
                              setActing({ kind: "checkpoint", note: flow.id, id: need.id });
                              setEvidence("");
                            }}
                          >
                            clear…
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {acting?.kind === "checkpoint" && acting.note === flow.id
                ? actionForm(`Evidence that ${acting.id} is discharged`)
                : null}
              <div className="devrr-gate-actions">
                <button
                  type="button"
                  className="devrr-approve"
                  disabled={blocked || busy !== null}
                  title={
                    blocked
                      ? `Refused while ${flow.outstanding.length} checkpoint(s) are outstanding`
                      : "Record that a human approved this"
                  }
                  onClick={() => void decide(flow.id, "approve")}
                >
                  <ShieldCheck size={14} /> Approve
                </button>
                <button
                  type="button"
                  className="devrr-reject"
                  disabled={busy !== null}
                  title="Saying no needs no proof"
                  onClick={() => void decide(flow.id, "reject")}
                >
                  Reject
                </button>
                {blocked ? (
                  <span className="devrr-quiet">
                    {flow.outstanding.length} outstanding — rejecting needs no proof
                  </span>
                ) : null}
              </div>
            </div>
          );
        })
      )}

      {findingsToShow.length ? (
        <>
          <h4 className="devrr-heading">Findings</h4>
          <ul className="devrr-findings">
            {findingsToShow.map((finding, i) => (
              <li key={`${finding.id}-${finding.note ?? finding.folder ?? i}`} className={finding.severity === "warn" ? "warn" : "error"}>
                <code>{finding.id}</code>
                {finding.note || finding.folder ? (
                  <span className="devrr-quiet">{finding.note ?? finding.folder}</span>
                ) : null}
                {finding.value ? <span className="devrr-value">{finding.value}</span> : null}
              </li>
            ))}
          </ul>
          {moreFindings > 0 ? (
            // Never a silent truncation: a list that quietly stops reads as a
            // project with fewer problems than it has.
            <p className="devrr-quiet">
              {moreFindings} more — run <code>devrr check</code> for all of them.
            </p>
          ) : null}
        </>
      ) : null}

      <h4 className="devrr-heading">Ready now</h4>
      {(state?.available && state.dag?.ready?.length) ? (
        <ul className="devrr-ready">
          {state.dag.ready.map((id) => (
            <li key={id}>
              <code>{id}</code>
              <button
                type="button"
                className="devrr-inline"
                title="Record this as done, with the file that proves it"
                onClick={() => {
                  setActing({ kind: "work", note: id });
                  setEvidence("");
                }}
              >
                done…
              </button>
              {acting?.kind === "work" && acting.note === id
                ? actionForm(`Evidence that ${id} is done`)
                : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="devrr-quiet">Nothing is unblocked.</p>
      )}

      {state?.available ? (
        <p className="devrr-path" title={state.checkout_path}>
          {state.checkout_path}
        </p>
      ) : null}
    </div>
  );
}
