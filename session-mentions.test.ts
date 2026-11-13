import test from "node:test";
import assert from "node:assert/strict";
import { Editor, CombinedAutocompleteProvider, type AutocompleteProvider } from "@earendil-works/pi-tui";
import { createSessionMentionProvider, extractSessionMentions, notificationPrompt, resolveSessionMentions, sessionMentionToken, workspaceMentionPeers } from "./session-mentions.ts";
import type { SessionInfo } from "./types.ts";

function session(id: string, name: string, workspace = "workspace-a", tab = "tab-a"): SessionInfo {
  return {
    id, name, cwd: `/projects/${name}`, model: "test-model", pid: process.pid, startedAt: 0, lastActivity: 0,
    herdrLocation: { status: "current", workspace: { id: workspace, label: workspace }, tab: { id: tab, label: tab }, paneId: `pane-${id}`, refreshedAt: 0 },
  };
}

const self = session("self-session", "self");
const frontend = session("12345678-frontend", "前端 开发", "workspace-a", "tab-b");
const reviewer = session("12345678-reviewer", "评审");
const remote = session("outside-workspace", "outside", "workspace-b");

test("mentions include other projects and tabs only inside the resolved current workspace", () => {
  assert.deepEqual(workspaceMentionPeers([self, frontend, reviewer, remote, { ...remote, id: "unhosted", herdrLocation: { status: "not_hosted" } }], self.id), [frontend, reviewer]);
  assert.throws(() => workspaceMentionPeers([frontend], self.id), /resolved Herdr workspace/);
  assert.throws(() => workspaceMentionPeers([{ ...self, herdrLocation: { status: "unavailable", paneId: "gone", reason: "pane_missing" } }, remote], self.id), /resolved Herdr workspace/);
});

test("mention tokens distinguish colliding short IDs and keep the selected full identity", () => {
  const peers = [frontend, reviewer];
  const token = sessionMentionToken(frontend, peers);
  assert.equal(token, "@前端_开发[12345678-f]");
  const selected = new Map([[token, frontend.id]]);
  const mentions = extractSessionMentions(`Notify ${token}, and ${token} again.`);
  assert.equal(mentions.length, 2);
  assert.deepEqual(resolveSessionMentions(mentions, peers, selected), [frontend]);
  assert.throws(() => resolveSessionMentions(mentions, [{ ...frontend, id: "12345678-f-replacement" }], selected), /no longer a unique connected recipient/);
  assert.throws(() => resolveSessionMentions(mentions, peers, new Map()), /Select the recipient again/);
});

test("quoted code, file references and email addresses never become notification targets", () => {
  const token = sessionMentionToken(frontend, [frontend]);
  assert.deepEqual(extractSessionMentions(`\`${token}\`\n\n\`\`\`ts\n${token}\n\`\`\`\n~~~\n${token}\n~~~\nmail${token} @./README.md @someone`), []);
  assert.deepEqual(extractSessionMentions(`\`\`\`ts\n${token}`), []);
  assert.deepEqual(extractSessionMentions(`\`\`${token}\`\`\n\`\`\` ${token}`), []);
  assert.equal(extractSessionMentions(`（${token}），${token}、${token}`).length, 3);
  const encoded = sessionMentionToken(session("worker:id", "worker"), []);
  assert.equal(extractSessionMentions(encoded)[0]?.prefix, "worker:i");
});

test("@ completion filters sessions and delegates file paths without inventing candidates", async () => {
  const delegated: string[] = [];
  const base: AutocompleteProvider = {
    async getSuggestions(lines) { delegated.push(lines[0]!); return { prefix: "file", items: [{ label: "README.md", value: "@./README.md" }] }; },
    applyCompletion: new CombinedAutocompleteProvider([], process.cwd()).applyCompletion,
  };
  let status: string | undefined;
  const selections = new Map<string, string>();
  const provider = createSessionMentionProvider(base, async () => [frontend, reviewer], (message) => { status = message; }, (token, id) => selections.set(token, id));
  const options = { signal: new AbortController().signal };
  const results = await provider.getSuggestions(["通知 @前端"], 0, 6, options);
  assert.equal(results?.items.length, 1);
  const item = results!.items[0]!;
  assert.match(item.description!, /projects.*tab-b/);
  provider.applyCompletion(["通知 @前端"], 0, 6, item, results!.prefix);
  assert.equal(selections.get(item.value), frontend.id);
  for (const input of ["@./READ", "@/tmp/", "@~/", '@"some path', "@C:\\work\\file", "mail@host"]) {
    await provider.getSuggestions([input], 0, input.length, options);
  }
  assert.equal(delegated.length, 6);
  const empty = createSessionMentionProvider(base, async () => [], (message) => { status = message; }, () => undefined);
  assert.deepEqual((await empty.getSuggestions(["@"], 0, 1, options))?.items, []);
  assert.match(status!, /No other intercom sessions/);
  const failed = createSessionMentionProvider(base, async () => { throw new Error("workspace unavailable"); }, (message) => { status = message; }, () => undefined);
  assert.equal(await failed.getSuggestions(["@"], 0, 1, options), null);
  assert.equal(status, "workspace unavailable");
});

test("native editor opens @ suggestions; selecting a recipient does not submit", async () => {
  const identity = (text: string) => text;
  const editor = new Editor({ requestRender() {} } as never, {
    borderColor: identity,
    selectList: { selectedPrefix: identity, selectedText: identity, description: identity, scrollInfo: identity, noMatch: identity },
  });
  const selected = new Map<string, string>();
  editor.setAutocompleteProvider(createSessionMentionProvider(
    new CombinedAutocompleteProvider([], process.cwd()), async () => [frontend], () => undefined, (token, id) => selected.set(token, id),
  ));
  let submitted: string | undefined;
  editor.onSubmit = (text) => { submitted = text; };
  editor.handleInput("@");
  const deadline = Date.now() + 1000;
  while (!(editor as unknown as { autocompleteState: unknown }).autocompleteState && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok((editor as unknown as { autocompleteState: unknown }).autocompleteState, "@ must naturally open the menu");
  editor.handleInput("\r");
  assert.equal(submitted, undefined);
  assert.equal(editor.getText(), `${sessionMentionToken(frontend, [frontend])} `);
  assert.equal(selected.size, 1);
  editor.handleInput("\r");
  assert.equal(submitted, sessionMentionToken(frontend, [frontend]));
});

test("aborted autocomplete does not publish stale workspace suggestions or status", async () => {
  const controller = new AbortController();
  controller.abort();
  let statusCalls = 0;
  const provider = createSessionMentionProvider(new CombinedAutocompleteProvider([], process.cwd()), async () => [frontend], () => { statusCalls++; }, () => undefined);
  assert.equal(await provider.getSuggestions(["@"], 0, 1, { signal: controller.signal }), null);
  assert.equal(statusCalls, 0);
});

test("notification input asks the current AI to compose contextual new messages to exact IDs", () => {
  const prompt = notificationPrompt("@前端[12345678] 同步刚才的决定", [frontend]);
  assert.match(prompt, /Use the current conversation/);
  assert.match(prompt, /Do not merely forward/);
  assert.match(prompt, /action: "notify"/);
  assert.match(prompt, /not replies to pending asks/);
  assert.ok(prompt.includes(frontend.id));
});
