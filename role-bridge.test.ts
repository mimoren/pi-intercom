import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_FLAG_GET_EVENT,
  AGENT_ROLE_SNAPSHOT_VERSION,
  RoleRevisionGate,
  parseAgentRoleSnapshot,
  requestAgentRoleSnapshot,
  rolePresenceOf,
  roleRevisionOf,
  type AgentRoleSnapshot,
  type EventBusLike,
} from "./role-bridge.ts";

function snapshot(overrides: Partial<AgentRoleSnapshot> = {}): AgentRoleSnapshot {
  return {
    version: AGENT_ROLE_SNAPSHOT_VERSION,
    sessionId: "session-a",
    state: "active",
    producerEpoch: "prod-1",
    generation: 1,
    role: { id: "kaoru", source: "project:/repo/a" },
    ...overrides,
  };
}

/** A producer that answers `agent-flag:get` the way CLIM does: synchronously, first reply wins. */
function producer(answers: Array<unknown | (() => unknown)>): EventBusLike & { asks: number } {
  const bus = {
    asks: 0,
    emit(event: string, payload: unknown) {
      if (event !== AGENT_FLAG_GET_EVENT) return;
      bus.asks += 1;
      const next = answers.shift();
      if (next === undefined) return;
      const value = typeof next === "function" ? (next as () => unknown)() : next;
      const reply = (payload as { reply?: (value: unknown) => void }).reply;
      reply?.(value);
      // A second reply must be ignored, exactly like a duplicated event handler.
      reply?.(snapshot({ role: { id: "impostor" } }));
    },
  };
  return bus;
}

test("a missing producer answer stays unknown instead of becoming no_role", () => {
  const silent: EventBusLike = { emit() {} };
  assert.equal(requestAgentRoleSnapshot(silent), undefined);
  assert.equal(requestAgentRoleSnapshot(producer([])), undefined);
  // The bridge never turns "no answer" into a claim.
  assert.equal(rolePresenceOf(snapshot({ state: "not_ready" })), undefined);
});

test("only the first synchronous reply is accepted", () => {
  const resolved = requestAgentRoleSnapshot(producer([snapshot()]));
  assert.equal(resolved?.role?.id, "kaoru");
  assert.notEqual(resolved?.role?.id, "impostor");
});

test("an invalid or unknown-version snapshot is discarded rather than partially used", () => {
  const cases: unknown[] = [
    undefined,
    null,
    "active",
    { ...snapshot(), version: 2 },
    { ...snapshot(), sessionId: "" },
    { ...snapshot(), producerEpoch: "" },
    { ...snapshot(), generation: -1 },
    { ...snapshot(), generation: 1.5 },
    { ...snapshot(), state: "running" },
    { ...snapshot(), state: "active", role: undefined },
    { ...snapshot(), state: "active", role: { id: "  " } },
    { ...snapshot(), state: "no_role" },
  ];
  for (const value of cases) {
    assert.equal(parseAgentRoleSnapshot(value), undefined, `must reject ${JSON.stringify(value)}`);
  }
});

test("presence carries the producer revision and never sends not_ready", () => {
  assert.deepEqual(rolePresenceOf(snapshot()), {
    role: { id: "kaoru", source: "project:/repo/a", revision: "prod-1:1" },
  });
  assert.equal(roleRevisionOf(snapshot()), "prod-1:1");
  assert.deepEqual(rolePresenceOf(snapshot({ state: "no_role", role: undefined })), { role: null });
  assert.equal(rolePresenceOf(snapshot({ state: "not_ready", role: undefined })), undefined);
});

test("load order: a ready event before the producer exists leaves the role unknown, later snapshots apply", () => {
  const gate = new RoleRevisionGate();
  const early = requestAgentRoleSnapshot(producer([]));
  assert.equal(early, undefined);

  const becameReady = requestAgentRoleSnapshot(producer([snapshot({ state: "no_role", role: undefined, generation: 1 })]));
  assert.ok(becameReady);
  assert.equal(gate.accept(becameReady), true);
  assert.deepEqual(rolePresenceOf(becameReady), { role: null });

  const activated = requestAgentRoleSnapshot(producer([snapshot({ generation: 2 })]));
  assert.ok(activated);
  assert.equal(gate.accept(activated), true);
  assert.equal(rolePresenceOf(activated)?.role?.id, "kaoru");
});

test("repeated snapshots are deduplicated and a stale generation is ignored", () => {
  const gate = new RoleRevisionGate();
  const active = snapshot();
  assert.equal(gate.accept(active), true);
  assert.equal(gate.accept(active), false, "the same snapshot must not rotate the broker epoch");
  assert.equal(gate.accept(snapshot({ generation: 0 })), false, "an older generation is stale");
  assert.equal(gate.accept(snapshot({ generation: 2 })), true);
  // Every state change bumps the generation, so a different state at the same
  // generation is a producer contract violation and stays rejected.
  assert.equal(gate.accept(snapshot({ generation: 2, state: "no_role", role: undefined })), false);
  assert.equal(gate.accept(snapshot({ generation: 3, state: "no_role", role: undefined })), true);
  assert.equal(gate.accept(snapshot({ generation: 4 })), true);
});

test("a producer reload wins even though its generation restarts", () => {
  const gate = new RoleRevisionGate();
  assert.equal(gate.accept(snapshot({ producerEpoch: "prod-1", generation: 9 })), true);
  // Same role, new producer instance: the broker must rotate so old pins break.
  const reloaded = snapshot({ producerEpoch: "prod-2", generation: 0 });
  assert.equal(gate.accept(reloaded), true);
  assert.equal(roleRevisionOf(reloaded), "prod-2:0");
  // Late events from the previous instance are not comparable and must not resurrect it.
  assert.equal(gate.accept(snapshot({ producerEpoch: "prod-1", generation: 10 })), true);
});

test("a forced publish re-sends the same revision to a new broker endpoint", () => {
  const gate = new RoleRevisionGate();
  const active = snapshot();
  assert.equal(gate.accept(active), true);
  assert.equal(gate.accept(active), false);
  // A reconnect gets a new endpoint whose role state starts unknown, so the
  // identical snapshot has to be published again.
  assert.equal(gate.accept(active, { force: true }), true);
});

test("a session switch resets the gate so the new session applies its own snapshot", () => {
  const gate = new RoleRevisionGate();
  assert.equal(gate.accept(snapshot({ generation: 5 })), true);
  gate.reset();
  assert.equal(gate.accept(snapshot({ sessionId: "session-b", generation: 0, role: { id: "wtdog" } })), true);
  assert.equal(rolePresenceOf(snapshot({ sessionId: "session-b", generation: 0, role: { id: "wtdog" } }))?.role?.id, "wtdog");
});

test("a snapshot from another session restarts tracking instead of merging generations", () => {
  const gate = new RoleRevisionGate();
  assert.equal(gate.accept(snapshot({ sessionId: "session-a", generation: 3 })), true);
  // The wiring drops mismatched sessions before the gate; if one does reach it,
  // it must not inherit this session's generation counter.
  assert.equal(gate.accept(snapshot({ sessionId: "session-b", generation: 0 })), true);
  assert.equal(gate.accept(snapshot({ sessionId: "session-b", generation: 0 })), false);
});
