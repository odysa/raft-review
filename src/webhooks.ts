// Raft App Notifications: signed Raft-to-App webhooks.
//
// Raft POSTs a JSON body with headers
//   x-raft-delivery:  delivery id (retries reuse it)
//   x-raft-timestamp: unix seconds
//   x-raft-signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${body}`)>
// (raft-source packages/server/src/services/appNotificationDeliveryService.ts).
// We use the member events to end access the moment Raft says so, instead of
// waiting for the next 60-second userinfo re-check.

import { createHmac, timingSafeEqual } from "node:crypto";

import { get, run, type Db } from "./db.ts";

export const SUBSCRIBED_EVENTS = ["server.member_removed", "server.member_role_changed"] as const;
const MAX_SKEW_SECONDS = 300;

export class WebhookError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Verify against every configured secret: during rotation Raft keeps the
 *  previous secret valid for a while, so both may be in use. */
export function verifyWebhook(input: {
  secrets: string[];
  body: string;
  timestamp: string | undefined;
  signature: string | undefined;
  now?: number;
}): void {
  if (input.secrets.length === 0) throw new WebhookError(404, "not_found", "webhooks are not configured");
  const ts = Number(input.timestamp);
  if (!input.timestamp || !Number.isInteger(ts)) throw new WebhookError(400, "bad_timestamp", "x-raft-timestamp is required");
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) throw new WebhookError(401, "stale_timestamp", "timestamp outside the allowed window");
  const given = Buffer.from(input.signature ?? "");
  const ok = input.secrets.some((secret) => {
    const expected = Buffer.from(signWebhook(secret, input.timestamp!, input.body));
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
  if (!ok) throw new WebhookError(401, "bad_signature", "signature does not match");
}

export interface WebhookResult {
  handled: boolean;
  duplicate?: boolean;
  type?: string;
  sessions_ended?: number;
}

/** Apply a verified delivery. Idempotent per delivery id. */
export function handleWebhook(db: Db, deliveryId: string | undefined, payload: any): WebhookResult {
  if (!deliveryId) throw new WebhookError(400, "missing_delivery", "x-raft-delivery is required");
  if (get(db, "SELECT 1 AS x FROM webhook_deliveries WHERE id = ?", deliveryId)) return { handled: true, duplicate: true };
  run(db, "INSERT INTO webhook_deliveries (id, received_at) VALUES (?, ?)", deliveryId, Date.now());
  run(db, "DELETE FROM webhook_deliveries WHERE received_at < ?", Date.now() - 7 * 24 * 3600 * 1000);

  const type = payload?.event?.type;
  const sub = payload?.event?.subject?.sub;
  if (typeof type !== "string") throw new WebhookError(400, "bad_payload", "event.type is required");
  // `sub` is present only for principals who signed in to this App; others
  // have no sessions here, so there is nothing to do.
  if (typeof sub !== "string" || !sub) return { handled: false, type };

  const count = (get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", sub)?.n) ?? 0;
  if (type === "server.member_removed") {
    run(db, "DELETE FROM sessions WHERE user_id = ?", sub);
    return { handled: true, type, sessions_ended: count };
  }
  if (type === "server.member_role_changed") {
    // Force a userinfo re-check on the next request.
    run(db, "UPDATE sessions SET verified_at = 0 WHERE user_id = ?", sub);
    return { handled: true, type, sessions_ended: 0 };
  }
  return { handled: false, type };
}
