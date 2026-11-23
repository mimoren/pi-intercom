import test from "node:test";
import assert from "node:assert/strict";
import net from "net";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { pathToFileURL } from "node:url";
import { writeMessage, createMessageReader } from "./framing.ts";
import type { BrokerMessage, Message, SessionInfo } from "../types.ts";

const repoDir = process.cwd();
// The broker's unix socket path is limited to ~104 bytes on macOS, so this
// prefix stays short: a longer temp directory makes the broker fail to listen.
const homeDir = mkdtempSync(path.join(tmpdir(), "pi-role-"));
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousHerdrPaneId = process.env.HERDR_PANE_ID;
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;
delete process.env.HERDR_PANE_ID;
process.on("exit", () => {
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  if (previousHerdrPaneId === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = previousHerdrPaneId;
  rmSync(homeDir, { recursive: true, force: true });
});

const { IntercomClient } = await import("./client.ts");
const { getTsxLoaderPath } = await import("./spawn.ts");
const { getBrokerConnectTarget } = await import("./paths.ts");
const tsxImportArgs = ["--import", pathToFileURL(getTsxLoaderPath()).href];

function registration(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    cwd: repoDir,
    model: "test-model",
    pid: process.pid,
    startedAt: Date.now(),
    lastActivity: Date.now(),
    ...extra,
  };
}

async function waitForBrokerReady(broker: ChildProcess): Promise<void> {
  const stdout = broker.stdout;
  if (!stdout) throw new Error("Broker stdout is unavailable");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Broker startup timed out"));
    }, 10_000);
    const onStdout = (chunk: Buffer) => {
      if (chunk.toString().includes("Intercom broker started")) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`Broker exited before startup (code ${code})`));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      stdout.off("data", onStdout);
      broker.off("exit", onExit);
    };
    stdout.on("data", onStdout);
    broker.on("exit", onExit);
  });
}

async function startBroker(): Promise<{ broker: ChildProcess; stop: () => Promise<void> }> {
  const broker = spawn(process.execPath, [...tsxImportArgs, path.join(repoDir, "broker", "broker.ts")], {
    cwd: repoDir,
    env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForBrokerReady(broker);
  return {
    broker,
    stop: async () => {
      broker.kill("SIGTERM");
      await once(broker, "exit").catch(() => undefined);
    },
  };
}

/** Roster row for one session, read through a fresh request so no cache can hide a change. */
async function rosterRow(viewer: IntercomClient, id: string): Promise<SessionInfo> {
  const sessions = await viewer.listSessions({ global: true });
  const row = sessions.find((session) => session.id === id);
  assert.ok(row, `session ${id} is missing from the roster`);
  return row;
}

test("broker projects a registered role and rotates the role epoch only on a real change", { concurrency: false }, async () => {
  const { stop } = await startBroker();
  const viewer = new IntercomClient();
  const worker = new IntercomClient();
  const updates: SessionInfo[] = [];
  viewer.on("presence_update", (session: SessionInfo) => updates.push(session));

  try {
    await viewer.connect(registration("viewer"));
    await worker.connect(registration("worker", { role: { id: "wtdog", source: "project:/repo/a", revision: "prod-1:1" } }));

    const initial = await rosterRow(viewer, worker.sessionId!);
    assert.deepEqual(initial.role, { id: "wtdog", source: "project:/repo/a" });
    assert.equal(typeof initial.roleEpoch, "string");
    assert.equal(initial.roleState, "active");
    // A session that never declared a role stays unknown: no roleState at all.
    const viewerRow = await rosterRow(viewer, viewer.sessionId!);
    assert.equal(viewerRow.role, undefined);
    assert.equal(viewerRow.roleEpoch, undefined);
    assert.equal(viewerRow.roleState, undefined);

    const firstEpoch = initial.roleEpoch;
    // A repeated snapshot of the same producer revision must not invalidate pins.
    worker.updatePresence({ role: { id: "wtdog", source: "project:/repo/a", revision: "prod-1:1" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await rosterRow(viewer, worker.sessionId!)).roleEpoch, firstEpoch);

    // A producer reload keeps the role but changes the revision, so the pin must break.
    worker.updatePresence({ role: { id: "wtdog", source: "project:/repo/a", revision: "prod-2:1" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reloaded = await rosterRow(viewer, worker.sessionId!);
    assert.equal(reloaded.role?.id, "wtdog");
    assert.notEqual(reloaded.roleEpoch, firstEpoch);

    // Switching the role rotates again and reaches peers as an ordinary presence update.
    worker.updatePresence({ role: { id: "wtree", source: "project:/repo/b", revision: "prod-2:2" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const switched = await rosterRow(viewer, worker.sessionId!);
    assert.deepEqual(switched.role, { id: "wtree", source: "project:/repo/b" });
    assert.notEqual(switched.roleEpoch, reloaded.roleEpoch);
    const update = updates.find((session) => session.id === worker.sessionId && session.role?.id === "wtree");
    assert.ok(update, "peers must see the role switch in a presence update");

    // Clearing is a definite answer, not a return to unknown.
    worker.updatePresence({ role: null });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const cleared = await rosterRow(viewer, worker.sessionId!);
    assert.equal(cleared.role, undefined);
    assert.equal(cleared.roleEpoch, undefined);
    assert.equal(cleared.roleState, "no_role");
    // A session initialized without a role says so at registration, and a viewer
    // that connects afterwards still reads the same answer.
    const never = new IntercomClient();
    await never.connect(registration("initialized-no-role", { role: null }));
    const late = new IntercomClient();
    await late.connect(registration("late-viewer"));
    try {
      const neverRow = await rosterRow(late, never.sessionId!);
      assert.equal(neverRow.role, undefined);
      assert.equal(neverRow.roleEpoch, undefined);
      assert.equal(neverRow.roleState, "no_role");
      // Both answers stay distinguishable side by side in one roster.
      const lateRow = await rosterRow(late, late.sessionId!);
      assert.equal(lateRow.roleState, undefined, "unknown must not read as no_role");
      const clearedRow = await rosterRow(late, worker.sessionId!);
      assert.equal(clearedRow.roleState, "no_role");
    } finally {
      await never.disconnect().catch(() => undefined);
      await late.disconnect().catch(() => undefined);
    }

    worker.updatePresence({ role: { id: "wtdog", source: "project:/repo/a", revision: "prod-2:3" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reactivated = await rosterRow(viewer, worker.sessionId!);
    assert.equal(reactivated.roleState, "active");
    assert.notEqual(reactivated.roleEpoch, firstEpoch);
  } finally {
    await viewer.disconnect().catch(() => undefined);
    await worker.disconnect().catch(() => undefined);
    await stop();
  }
});

test("role pin rejects a switched role and delivers nothing", { concurrency: false }, async () => {
  const { stop } = await startBroker();
  const sender = new IntercomClient();
  const worker = new IntercomClient();
  const received: Message[] = [];
  worker.on("message", (_from: SessionInfo, message: Message) => received.push(message));

  try {
    await sender.connect(registration("sender"));
    await worker.connect(registration("worker", { role: { id: "wtdog", source: "project:/repo/a", revision: "prod-1:1" } }));
    const pinned = await rosterRow(sender, worker.sessionId!);

    worker.updatePresence({ role: { id: "wtree", source: "project:/repo/a", revision: "prod-1:2" } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await sender.send(worker.sessionId!, {
      text: "consult the old role",
      targetEpoch: pinned.endpointEpoch,
      targetRoleEpoch: pinned.roleEpoch,
    });
    assert.equal(result.delivered, false);
    assert.equal(result.code, "E_ROLE_CHANGED");
    // Never retried and never rewritten: the sender has to reselect the role.
    assert.equal(result.retryable, false);
    assert.equal(result.outcomeKnown, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(received, []);

    // The fresh pin still delivers, so the refusal is about the revision, not the session.
    const current = await rosterRow(sender, worker.sessionId!);
    const accepted = await sender.send(worker.sessionId!, {
      text: "consult the new role",
      targetEpoch: current.endpointEpoch,
      targetRoleEpoch: current.roleEpoch,
    });
    assert.equal(accepted.delivered, true);
    assert.equal(received.length, 1);
  } finally {
    await sender.disconnect().catch(() => undefined);
    await worker.disconnect().catch(() => undefined);
    await stop();
  }
});

test("role pin against a session without a role is refused as unavailable", { concurrency: false }, async () => {
  const { stop } = await startBroker();
  const sender = new IntercomClient();
  const plain = new IntercomClient();
  const received: Message[] = [];
  plain.on("message", (_from: SessionInfo, message: Message) => received.push(message));

  try {
    await sender.connect(registration("sender"));
    await plain.connect(registration("older-client"));
    const row = await rosterRow(sender, plain.sessionId!);

    const result = await sender.send(plain.sessionId!, {
      text: "consult a role that was never reported",
      targetEpoch: row.endpointEpoch,
      targetRoleEpoch: "00000000-0000-4000-8000-000000000000",
    });
    assert.equal(result.delivered, false);
    assert.equal(result.code, "E_ROLE_UNAVAILABLE");
    assert.equal(result.retryable, false);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(received, []);
  } finally {
    await sender.disconnect().catch(() => undefined);
    await plain.disconnect().catch(() => undefined);
    await stop();
  }
});

test("broker refuses a role pin that has no endpoint pin", { concurrency: false }, async () => {
  const { stop } = await startBroker();
  const target = getBrokerConnectTarget();
  assert.equal(typeof target, "string", "this test needs the unix socket transport");
  const socket = net.connect(target as string);
  const messages: BrokerMessage[] = [];
  socket.on("data", createMessageReader((message: BrokerMessage) => messages.push(message)));
  const closed = once(socket, "close").catch(() => undefined);

  try {
    await once(socket, "connect");
    writeMessage(socket, {
      type: "register",
      sessionId: "raw-sender",
      session: {
        cwd: repoDir,
        model: "test-model",
        pid: process.pid,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      },
    });
    const registered = await waitFor(() => messages.find((message) => message.type === "registered"));
    assert.equal(registered.type, "registered");

    writeMessage(socket, {
      type: "send",
      to: "nobody",
      message: { id: "role-without-endpoint", timestamp: Date.now(), content: { text: "x" } },
      targetRoleEpoch: "00000000-0000-4000-8000-000000000000",
    });
    const failed = await waitFor(() => messages.find((message) => message.type === "delivery_failed"));
    assert.equal(failed.type, "delivery_failed");
    if (failed.type === "delivery_failed") {
      assert.equal(failed.code, "E_INVALID_TARGET");
      assert.equal(failed.messageId, "role-without-endpoint");
    }
  } finally {
    socket.destroy();
    await closed;
    await stop();
  }
});

test("a broker without role routing is refused before any send frame is written", { concurrency: false }, async () => {
  const target = getBrokerConnectTarget();
  assert.equal(typeof target, "string", "this test needs the unix socket transport");
  const frames: unknown[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", createMessageReader((frame: { type?: string; sessionId?: string }) => {
      frames.push(frame);
      if (frame.type === "register") {
        // An older broker: exact delivery exists, role routing does not.
        writeMessage(socket, { type: "registered", sessionId: "old-broker-client", features: ["exact-send-v1"] });
      }
    }));
  });
  server.listen(target as string);
  await once(server, "listening");
  const client = new IntercomClient();

  try {
    await client.connect(registration("pinning-client"));
    await assert.rejects(
      client.send("someone", { text: "x", targetEpoch: "endpoint", targetRoleEpoch: "role" }),
      /role-pinned delivery/,
    );
    // The refusal happens on this side, so the old broker never sees an unpinnable request.
    assert.deepEqual(frames.filter((frame) => (frame as { type?: string }).type === "send"), []);
  } finally {
    await client.disconnect().catch(() => undefined);
    server.close();
    await once(server, "close").catch(() => undefined);
  }
});

test("an invalid role pin is refused on this side and writes no send frame", { concurrency: false }, async () => {
  const target = getBrokerConnectTarget();
  assert.equal(typeof target, "string", "this test needs the unix socket transport");
  const frames: Array<{ type?: string }> = [];
  const server = net.createServer((socket) => {
    socket.on("data", createMessageReader((frame: { type?: string }) => {
      frames.push(frame);
      if (frame.type === "register") {
        // A current broker: both capabilities advertised, so only the value itself can fail.
        writeMessage(socket, { type: "registered", sessionId: "current-broker-client", features: ["extension-bus-v1", "exact-send-v1", "role-routing-v1"] });
      }
    }));
  });
  server.listen(target as string);
  await once(server, "listening");
  const client = new IntercomClient();

  try {
    await client.connect(registration("pinning-client"));
    // An explicit empty pin must not fall back to an ordinary endpoint or alias send.
    await assert.rejects(
      client.send("someone", { text: "x", targetEpoch: "endpoint", targetRoleEpoch: "" }),
      /non-empty target role epoch/,
    );
    await assert.rejects(
      client.send("someone", { text: "x", targetEpoch: "endpoint", targetRoleEpoch: "   " }),
      /non-empty target role epoch/,
    );
    // A pin without its endpoint cannot be validated either.
    await assert.rejects(
      client.send("someone", { text: "x", targetRoleEpoch: "role" }),
      /requires the target endpoint epoch/,
    );
    assert.deepEqual(frames.filter((frame) => frame.type === "send"), [], "no send frame may reach the broker");
  } finally {
    await client.disconnect().catch(() => undefined);
    server.close();
    await once(server, "close").catch(() => undefined);
  }
});

async function waitFor<T>(find: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = find();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a broker message");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
