import type { ListLocationScope } from "./config.ts";
import type { HerdrClient } from "./project-agent.ts";
import { createHerdrClient } from "./project-agent.ts";
import type { HerdrLocation, SessionInfo } from "./types.ts";

type RecordValue = Record<string, unknown>;

let activeSnapshot: Promise<Awaited<ReturnType<HerdrClient["run"]>>> | undefined;

function readCurrentSnapshot(client: HerdrClient): Promise<Awaited<ReturnType<HerdrClient["run"]>>> {
  if (activeSnapshot) return activeSnapshot;
  activeSnapshot = client.run(["api", "snapshot"], { timeoutMs: 3_000 });
  void activeSnapshot.finally(() => { activeSnapshot = undefined; });
  return activeSnapshot;
}

function record(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const item = record(value)?.[key];
  return typeof item === "string" && item.length > 0 ? item : undefined;
}

function recordsField(value: unknown, key: string): RecordValue[] | undefined {
  const items = record(value)?.[key];
  return Array.isArray(items) && items.every((item) => record(item) !== undefined)
    ? items as RecordValue[]
    : undefined;
}

function unavailable(paneId: string, reason: Extract<HerdrLocation, { status: "unavailable" }>['reason'], detail?: string): HerdrLocation {
  return { status: "unavailable", paneId, reason, ...(detail ? { detail } : {}) };
}
/** Herdr prints the Agent label in its own sidebar and tab strip: one safe line only. */
const UNSAFE_AGENT_LABEL = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
const MAX_AGENT_LABEL_CHARS = 24;
/** Herdr CLI kind → the name that tool shows for itself; unknown tools keep their own name. */
const CLIENT_NAMES: Record<string, string> = { pi: "Pi", codex: "Codex", claude: "Claude" };
function sanitizeAgentLabel(value: string | undefined): string | undefined {
  const label = value?.replace(UNSAFE_AGENT_LABEL, " ").replace(/\s+/g, " ").trim();
  return label ? [...label].slice(0, MAX_AGENT_LABEL_CHARS).join("") : undefined;
}
/**
 * Herdr's own Agent label for one pane record. A source-scoped `display_agent`
 * report (e.g. `clim:pi-role`, ADS) always wins; the raw CLI kind is only the
 * fallback, so this never guesses an identity from a process title or task slug.
 */
export function paneAgentLabel(value: unknown): string | undefined {
  const pane = record(value);
  if (!pane) return undefined;
  const display = sanitizeAgentLabel(stringField(pane, "display_agent"));
  if (display) return display;
  const kind = stringField(pane, "agent");
  return kind ? sanitizeAgentLabel(CLIENT_NAMES[kind] ?? kind) : undefined;
}
/**
 * Read-only Agent labels for a roster, joined against the pane ids the broker
 * already projected. This stays on the client so a running broker needs no
 * restart; any Herdr failure returns the roster untouched and the caller keeps
 * its known CLI fallback. It never throws into the menu.
 */
export async function resolveHerdrAgentLabels(
  sessions: SessionInfo[],
  options: { client?: HerdrClient } = {},
): Promise<SessionInfo[]> {
  if (!sessions.some((session) => session.herdrPaneId)) return sessions;
  const client = options.client ?? createHerdrClient();
  const result = await client.run<RecordValue>(["agent", "list"], { timeoutMs: 3_000 });
  if (result.ok === false) return sessions;
  const agents = recordsField(result.data, "agents");
  if (!agents) return sessions;
  const labels = new Map<string, string>();
  for (const agent of agents) {
    const paneId = stringField(agent, "pane_id");
    const label = paneAgentLabel(agent);
    if (paneId && label) labels.set(paneId, label);
  }
  if (labels.size === 0) return sessions;
  return sessions.map((session) => {
    if (!session.herdrPaneId) return session;
    const location = session.herdrLocation;
    // Brokers that project the live pane id win; the launch alias is the older join key.
    const label = (location?.status === "current" ? labels.get(location.paneId) : undefined)
      ?? labels.get(session.herdrPaneId);
    return label ? { ...session, agentLabel: label } : session;
  });
}

/** Filter only the roster view; explicit session addressing remains available. */
export function filterSessionsByLocationScope(
  sessions: SessionInfo[], selfId: string, scope: ListLocationScope,
): SessionInfo[] {
  if (scope !== "workspace" && scope !== "tab") return sessions;
  const viewer = sessions.find((session) => session.id === selfId);
  const self = viewer?.herdrLocation;
  if (!self || self.status !== "current") {
    // Non-Herdr clients retain the ordinary machine roster. Hosted clients
    // must not expose unrelated workspaces when live location lookup fails.
    return viewer?.herdrPaneId || self?.status === "unavailable"
      ? sessions.filter((session) => session.id === selfId)
      : sessions;
  }
  return sessions.filter((session) => {
    if (session.id === selfId) return true;
    const location = session.herdrLocation;
    if (!location || location.status !== "current") return false;
    if (scope === "tab") return location.tab.id === self.tab.id;
    if (location.workspace.id === self.workspace.id) return true;
    const parent = self.workspace.worktree;
    const peer = location.workspace.worktree;
    // Herdr groups linked worktrees under their main checkout. Compare the
    // direct relation only: siblings must not inherit visibility transitively.
    return Boolean(parent && peer && parent.repoKey === peer.repoKey
      && parent.isLinkedWorktree !== peer.isLinkedWorktree);
  });
}

/**
 * Resolve every Herdr-hosted session against one live Herdr snapshot. The
 * registration-time pane id is only a stable join key; workspace and tab are
 * always taken from this snapshot and are never cached.
 */
export async function resolveHerdrLocations(
  sessions: SessionInfo[],
  options: { client?: HerdrClient; now?: () => number; sessionPaths?: ReadonlyMap<string, string> } = {},
): Promise<SessionInfo[]> {
  const hosted = sessions.filter((session) => session.herdrPaneId);
  if (hosted.length === 0) {
    // Preserve the upstream roster byte-for-byte in installations where Herdr
    // is not in use: no subprocess and no additive rendering/state.
    return sessions;
  }

  const client = options.client ?? createHerdrClient();
  // Injected clients remain isolated for deterministic tests. Production calls
  // share only an already-in-flight snapshot, collapsing concurrent list bursts
  // without caching a result for a later request.
  const snapshotResult = await (options.client
    ? client.run(["api", "snapshot"], { timeoutMs: 3_000 })
    : readCurrentSnapshot(client));
  if (snapshotResult.ok === false) {
    const reason = snapshotResult.error.code === "HERDR_UNAVAILABLE"
      ? "herdr_unavailable"
      : snapshotResult.error.code === "HERDR_UNSUPPORTED_VERSION"
        ? "unsupported"
        : "command_failed";
    return sessions.map((session) => session.herdrPaneId
      ? { ...session, herdrLocation: unavailable(session.herdrPaneId, reason, snapshotResult.error.message) }
      : { ...session, herdrLocation: { status: "not_hosted" } });
  }

  const envelope = record(snapshotResult.data);
  const snapshot = record(envelope?.snapshot) ?? envelope;
  const panes = recordsField(snapshot, "panes");
  const tabs = recordsField(snapshot, "tabs");
  const workspaces = recordsField(snapshot, "workspaces");
  if (!panes || !tabs || !workspaces) {
    return sessions.map((session) => session.herdrPaneId
      ? { ...session, herdrLocation: unavailable(session.herdrPaneId, "invalid_response", "Herdr snapshot omitted panes, tabs, or workspaces.") }
      : { ...session, herdrLocation: { status: "not_hosted" } });
  }

  const refreshedAt = (options.now ?? Date.now)();
  const keyed = (items: RecordValue[], key: string): Array<[string, RecordValue]> => items.flatMap((item) => {
    const id = stringField(item, key);
    return id ? [[id, item]] : [];
  });
  const panesById = new Map(keyed(panes, "pane_id"));
  const panesBySessionPath = new Map<string, RecordValue | null>();
  for (const pane of panes) {
    const agentSession = record(pane.agent_session);
    const sessionPath = agentSession
      && stringField(agentSession, "kind") === "path"
      && stringField(agentSession, "source") === "herdr:pi"
      ? stringField(agentSession, "value")
      : undefined;
    if (!sessionPath) continue;
    panesBySessionPath.set(sessionPath, panesBySessionPath.has(sessionPath) ? null : pane);
  }
  const tabsById = new Map(keyed(tabs, "tab_id"));
  const workspacesById = new Map(keyed(workspaces, "workspace_id"));

  return sessions.map((session): SessionInfo => {
    const paneId = session.herdrPaneId;
    if (!paneId) return { ...session, herdrLocation: { status: "not_hosted" } };
    // Pane ids are workspace-qualified launch aliases and change when a pane is
    // moved. New clients register the Pi session file, which Herdr carries with
    // the terminal across moves. Older clients fall back to a direct pane-id
    // lookup and explicitly become unavailable after a move.
    const sessionPath = options.sessionPaths?.get(session.id);
    const pane = sessionPath
      ? panesBySessionPath.get(sessionPath)
      : panesById.get(paneId);
    if (pane === null) {
      return { ...session, herdrLocation: unavailable(paneId, "invalid_response", "Multiple Herdr panes advertise the same Pi session identity.") };
    }
    if (!pane) return { ...session, herdrLocation: unavailable(paneId, "pane_missing", "The hosted Pi session is absent from the current Herdr snapshot.") };
    const currentPaneId = stringField(pane, "pane_id");
    const tabId = stringField(pane, "tab_id");
    const workspaceId = stringField(pane, "workspace_id");
    const tab = tabId ? tabsById.get(tabId) : undefined;
    const workspace = workspaceId ? workspacesById.get(workspaceId) : undefined;
    const tabLabel = stringField(tab, "label");
    const workspaceLabel = stringField(workspace, "label");
    if (!currentPaneId || !tabId || !workspaceId || !tabLabel || !workspaceLabel) {
      return { ...session, herdrLocation: unavailable(paneId, "invalid_response", "Herdr snapshot could not resolve the pane's current labeled tab and workspace.") };
    }
    const worktree = record(workspace?.worktree);
    const repoKey = stringField(worktree, "repo_key");
    const isLinkedWorktree = worktree?.is_linked_worktree;
    return {
      ...session,
      herdrLocation: {
        status: "current",
        workspace: { id: workspaceId, label: workspaceLabel,
          ...(repoKey && typeof isLinkedWorktree === "boolean"
            ? { worktree: { repoKey, isLinkedWorktree } } : {}),
        },
        tab: { id: tabId, label: tabLabel },
        paneId: currentPaneId,
        refreshedAt,
      },
    };
  });
}
