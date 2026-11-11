import { randomUUID } from "node:crypto";

import type { Config } from "./config.ts";
import { all, run, type Db, type User } from "./db.ts";
import type { RaftClient } from "./raft.ts";
import { getUser } from "./review.ts";

export type NotifyReason = "comment" | "new_thread" | "suggestion_accepted" | "suggestion_rejected" | "review_requested"
  | "pdf_needed" | "compile_failed";

export interface Notifier {
  notify(input: {
    agentId: string;
    actor: User;
    reason: NotifyReason;
    documentId: string;
    documentTitle: string;
    threadId: string | null;
    quote?: string;
    body?: string;
    dedupeKey: string;
  }): Promise<{ status: "queued" | "duplicate" | "no_grant" | "failed" | "disabled"; detail: string }>;
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const REASON_TEXT: Record<NotifyReason, string> = {
  comment: "replied in a review thread",
  new_thread: "commented on",
  suggestion_accepted: "accepted your suggestion in",
  suggestion_rejected: "rejected your suggestion in",
  review_requested: "asked you to review",
  pdf_needed: "accepted edits to the LaTeX of",
  compile_failed: "accepted edits, but the PDF failed to compile, in",
};

/** Wakes the reviewing agent through Raft's Agent Events API. The event tells
 *  the agent exactly which `raft integration invoke` calls to make next. */
export function createRaftNotifier(db: Db, config: Config, raft: RaftClient): Notifier {
  return {
    async notify(input) {
      const agent = getUser(db, input.agentId);
      const log = (status: string, detail: string) => {
        run(
          db,
          "INSERT INTO agent_events (id, agent_id, thread_id, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          randomUUID(), input.agentId, input.threadId, status, detail, Date.now(),
        );
      };
      if (!agent || agent.type !== "agent") {
        log("failed", "agent unknown");
        return { status: "failed", detail: "agent unknown" };
      }
      if (config.devLogin && !config.clientSecret) {
        log("disabled", "dev mode: no Raft credentials");
        return { status: "disabled", detail: "dev mode: no Raft credentials, agent must poll list_pending" };
      }
      const svc = JSON.stringify(config.serviceKey);
      const doc = `--param document_id=${input.documentId}`;
      const target = input.reason === "pdf_needed"
        ? `raft integration invoke --service ${svc} --action get_patch ${doc} --output review.patch; git apply it, compile, then upload_pdf ${doc} --param pdf_base64=@main.pdf.b64`
        : input.reason === "compile_failed"
          ? `raft integration invoke --service ${svc} --action get_compile_log ${doc}`
          : input.threadId
            ? `raft integration invoke --service ${svc} --action get_thread --param thread_id=${input.threadId}`
            : `raft integration invoke --service ${svc} --action get_document ${doc}`;
      const summary = clip(
        `${input.actor.name} ${REASON_TEXT[input.reason]} “${clip(input.documentTitle, 80)}”`
          + (input.body ? `: “${clip(input.body, 200)}”` : "")
          + `. Next: ${target}`,
        500,
      );
      try {
        const token = await raft.agentEventToken(agent);
        if (!token) {
          const detail = "agent has no remembered grant with agent:event:write; it will see this via list_pending";
          log("no_grant", detail);
          return { status: "no_grant", detail };
        }
        const res = await raft.postAgentEvent(token, { summary, externalEventId: `raft-review:${input.dedupeKey}` });
        if (res.status === 200 || res.status === 202) {
          const status = res.json?.status === "duplicate" ? "duplicate" : "queued";
          log(status, `event ${res.json?.id ?? "?"}`);
          return { status, detail: `event ${res.json?.id ?? "?"}` };
        }
        const detail = `agent-events HTTP ${res.status}: ${clip(JSON.stringify(res.json ?? {}), 300)}`;
        log("failed", detail);
        return { status: "failed", detail };
      } catch (err) {
        const detail = `notify error: ${(err as Error).message}`;
        log("failed", detail);
        return { status: "failed", detail };
      }
    },
  };
}

export function recentAgentEvents(db: Db, threadId: string) {
  return all<{ agent_id: string; status: string; detail: string; created_at: number }>(
    db, "SELECT agent_id, status, detail, created_at FROM agent_events WHERE thread_id = ? ORDER BY created_at DESC LIMIT 5", threadId,
  );
}
