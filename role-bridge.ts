/**
 * CLIM role snapshot → broker presence bridge.
 *
 * CLIM owns the role identity; this module only asks for the current snapshot
 * and decides what the broker should be told. Everything here is pure so the
 * event ordering can be tested with synthetic snapshots, without a producer.
 *
 * Contract (agreed with CLIM):
 * - `agent-flag:get` carries `{ version: 1, reply(snapshot) }`; the reply is
 *   synchronous and the first one wins.
 * - `agent-flag:ready` announces initialization, including sessions with no role.
 * - `agent-flag:changed` announces a switch, a clear, or a restore.
 * - A snapshot is `{ version, sessionId, state, producerEpoch, generation, role? }`
 *   where `state` is `not_ready | no_role | active`, `generation` is monotonic
 *   within one `producerEpoch`, and a reload starts a new `producerEpoch`.
 * - Nothing answering (older CLIM) means unknown, never "no role".
 */
export const AGENT_FLAG_CHANGED_EVENT = "agent-flag:changed";
export const AGENT_FLAG_READY_EVENT = "agent-flag:ready";
export const AGENT_FLAG_GET_EVENT = "agent-flag:get";
/** Only shape this bridge understands; a newer producer must keep it or add a new event. */
export const AGENT_ROLE_SNAPSHOT_VERSION = 1;

/** What the producer knows about its own role right now. */
export type AgentRoleState = "not_ready" | "no_role" | "active";

export interface AgentRoleSnapshot {
  version: number;
  sessionId: string;
  state: AgentRoleState;
  producerEpoch: string;
  generation: number;
  role?: { id: string; source?: string };
}

/** The presence payload the broker accepts; `null` is the definite "no role". */
export interface AgentRolePresence {
  role: { id: string; source?: string; revision: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/**
 * Validate a producer snapshot. An invalid or unknown-version snapshot is
 * discarded rather than partially trusted: guessing a role would let a malformed
 * producer make a session look like a different identity.
 */
export function parseAgentRoleSnapshot(value: unknown): AgentRoleSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== AGENT_ROLE_SNAPSHOT_VERSION) return undefined;
  const sessionId = nonEmptyString(value.sessionId);
  const producerEpoch = nonEmptyString(value.producerEpoch);
  const generation = value.generation;
  if (!sessionId || !producerEpoch) return undefined;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return undefined;
  const state = value.state;
  if (state !== "not_ready" && state !== "no_role" && state !== "active") return undefined;
  if (state !== "active") {
    return value.role === undefined
      ? { version: AGENT_ROLE_SNAPSHOT_VERSION, sessionId, state, producerEpoch, generation }
      : undefined;
  }
  if (!isRecord(value.role)) return undefined;
  const id = nonEmptyString(value.role.id);
  const source = value.role.source;
  if (!id) return undefined;
  if (source !== undefined && typeof source !== "string") return undefined;
  return {
    version: AGENT_ROLE_SNAPSHOT_VERSION,
    sessionId,
    state,
    producerEpoch,
    generation,
    role: { id, ...(source !== undefined ? { source } : {}) },
  };
}

export interface EventBusLike {
  emit(event: string, payload: unknown): void;
}

/**
 * Ask the producer for its current snapshot. A synchronous reply keeps this
 * side free of timeouts; a producer that never replies simply leaves the
 * identity unknown.
 */
export function requestAgentRoleSnapshot(events: EventBusLike): AgentRoleSnapshot | undefined {
  let received: unknown;
  let replied = false;
  let accepting = true;
  try {
    events.emit(AGENT_FLAG_GET_EVENT, {
      version: AGENT_ROLE_SNAPSHOT_VERSION,
      reply: (snapshot: unknown) => {
        if (!accepting || replied) return;
        received = snapshot;
        replied = true;
      },
    });
  } finally {
    accepting = false;
  }
  return parseAgentRoleSnapshot(received);
}

export interface PublicRole {
  id: string;
  source: "pi-user" | "pi-project";
  scope: "global" | "project";
  client: "pi";
  description?: string;
}

export function requestRoleDirectory(events: EventBusLike, sessionId: string): PublicRole[] | undefined {
  let reply: unknown;
  let answered = false;
  events.emit("agent-flag:directory", { version: AGENT_ROLE_SNAPSHOT_VERSION, reply: (value: unknown) => {
    if (!answered) { answered = true; reply = value; }
  } });
  if (!isRecord(reply) || reply.version !== AGENT_ROLE_SNAPSHOT_VERSION || reply.sessionId !== sessionId || !Array.isArray(reply.roles)) return undefined;
  const roles: PublicRole[] = [];
  for (const row of reply.roles) {
    if (!isRecord(row)) return undefined;
    const id = nonEmptyString(row.id);
    const { source, scope, client, description } = row;
    if (!id || (source !== "pi-user" && source !== "pi-project") || scope !== (source === "pi-project" ? "project" : "global") || client !== "pi" || (description !== undefined && typeof description !== "string")) return undefined;
    roles.push({ id, source, scope, client, ...(description === undefined ? {} : { description }) });
  }
  return roles;
}

/**
 * The revision the broker stores next to the role. It identifies the producer
 * instance and its generation, so the broker can rotate its own `roleEpoch` on
 * a reload of the same role while ignoring a repeated snapshot.
 */
export function roleRevisionOf(snapshot: AgentRoleSnapshot): string {
  return `${snapshot.producerEpoch}:${snapshot.generation}`;
}

/**
 * Presence for one snapshot, or undefined when nothing may be claimed.
 * `not_ready` must never be sent as `null`: that would turn "unknown yet" into
 * a definite "this session has no role" for every peer.
 */
export function rolePresenceOf(snapshot: AgentRoleSnapshot): AgentRolePresence | undefined {
  if (snapshot.state === "not_ready") return undefined;
  if (snapshot.state === "no_role") return { role: null };
  const role = snapshot.role;
  if (!role) return undefined;
  return { role: { id: role.id, ...(role.source !== undefined ? { source: role.source } : {}), revision: roleRevisionOf(snapshot) } };
}

/**
 * Drop late and repeated snapshots. A generation only moves forward inside one
 * producer instance, so an equal or lower one is stale no matter how it arrived;
 * a new `producerEpoch` is a reload and always wins.
 */
export class RoleRevisionGate {
  private sessionId: string | undefined;
  private producerEpoch: string | undefined;
  private generation = -1;

  reset(): void {
    this.sessionId = undefined;
    this.producerEpoch = undefined;
    this.generation = -1;
  }

  /** `force` records the snapshot without filtering: used when a new broker endpoint needs the current role again. */
  accept(snapshot: AgentRoleSnapshot, options: { force?: boolean } = {}): boolean {
    if (this.sessionId !== snapshot.sessionId) {
      this.sessionId = snapshot.sessionId;
      this.producerEpoch = snapshot.producerEpoch;
      this.generation = snapshot.generation;
      return true;
    }
    if (this.producerEpoch !== snapshot.producerEpoch) {
      this.producerEpoch = snapshot.producerEpoch;
      this.generation = snapshot.generation;
      return true;
    }
    if (this.generation > snapshot.generation) return false;
    if (!options.force && this.generation === snapshot.generation) return false;
    this.generation = snapshot.generation;
    return true;
  }
}
