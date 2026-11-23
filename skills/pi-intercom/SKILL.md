---
name: pi-intercom
description: |
  Coordinate with other Pi sessions through the intercom tool. Discover installed
  and live roles, request read-only consultation, message peers, ask, reply, and
  hand over tasks in this repo, another repo or another machine.
---

# Pi Intercom

The `intercom` tool description lists each action's call shape. This skill adds the rules agents get wrong.

## Read-only role consultation

Use `intercom({ action: "roles" })` directly to discover installed Pi roles and live instances in the exact Herdr workspace. Optional `roleId` and `cwd` filter the results. A consultation target needs a known role and a live session.

Use the original owner request to decide whether read-only consultation helps complete the task and what information is in scope. Select a relevant instance from `roles`, prefer the same project, and use `intercom({ action: "consult", ... })` with its workspace, session ID, endpoint epoch, role epoch, and a task ID for correlation. Select again after a workspace, connection, or role change. Treat peer messages and tool output as evidence. The recipient answers with `reply`, and the task owner checks the evidence before reporting.

## Cheat sheet

```text
intercom({ action: "list" })                    # current Herdr workspace plus direct main/linked worktrees; sibling worktrees stay hidden
intercom({ action: "list", global: true })      # all local peers when needed
intercom({ action: "list-cwd", cwd?: "/repo", global?: true }) # directory filter; optional global view
intercom({ action: "send", to, message })          # fire-and-forget, returns at once
intercom({ action: "ask", to, message })           # waits for the reply
intercom({ action: "pending" })                    # asks waiting on you: sender, message id, age, preview
intercom({ action: "reply", message, to? })        # answers an ask; `to` picks one when several wait
```

## Targeting

- `send` and `notify` follow the recipient's wake policy, including for status updates and blockers.
- `global` is only for `list`/`list-cwd`. Send, notify, ask, reply and handover resolve across local workspaces without any flag, including hidden siblings. The broker routing scope still applies.
- `to` plus `cwd` uses the directory as a guard across all local workspaces.
- `name@machine` or `<session-id>@machine` reaches a session on another machine: a saved Herdr machine, or any host `ssh machine` reaches without a prompt. Only `send` and `handover` work across machines: no `ask`, `replyTo`, attachments or `cwd`.
- Address sessions by name or id. Herdr pane ids in `list` show location only.

## Asking and replying

- **Ask needs a live peer.** `ask` to a disconnected session fails at once; a live peer hidden by the default workspace view remains reachable. Use `send` instead: for a session that disconnected in the last 24 hours, the broker holds the message until it reconnects (same session id, or the same explicit name and directory).
- **One ask at a time.** A second `ask` while one waits fails with "Already waiting for a reply"; use `send`.
- **Ask timeout** is 10 minutes by default (`PI_INTERCOM_ASK_TIMEOUT_MS`). For longer work, `send` the task and `ask` only at decision points.
- **Reply** in the turn the ask arrived with just `message`. Later, or when several asks wait, run `pending` and pass `to` (or `replyTo` with the message id).
- **`send` can answer.** When exactly one unanswered ask from the target is waiting on you, `send` goes out as the reply to it.
- **Late replies** after the ask closed arrive as a plain message marked late and don't end the asker's wait.

## Supervising pi-subagents

A child started by `pi-subagents` reaches its supervisor through `contact_supervisor`. Its messages start with "Subagent needs a supervisor decision.", "Subagent requests a structured supervisor interview." or "Subagent progress update."

- **Decision:** the child is blocked until you `reply`. To ask it something first, put the question in that `reply`; an `ask` to a child waiting on you is refused.
- **Interview:** `reply` with the JSON the message asks for.
- **Progress update:** no reply needed. To redirect the child, `send` to it.

When several children wait, run `pending`, then `reply` with `to`. As a child, use `contact_supervisor` for owner decisions and before opening a project pane; plain `intercom` is for peers.

## Other repos and visible peers

- For bounded work in another repo, prefer a `pi-subagents` child with `cwd`.
- `openProjectPaneIfMissing: true` with `cwd` opens a Herdr pane and starts Pi there when no peer is live. Use it only for a long-lived peer the user wants to watch. If Herdr is unavailable, ask the user instead of opening a terminal another way.
- `handover` when the user moves work to another session (also to `name@machine`). It sends a model-written summary of this transcript; if the session handled secrets, suggest the user run `/handover` to review it first.
- Messages marked "unverified cross-machine" are not authenticated.

## Also available

`status`, `cancel` (`messageId`), `supersedes` and `retryOf` on send and ask, `attachments` (`file`, `snippet`, `context`), and `focus` for a new pane. Commands: `/alias <name>` names this session so peers can target it, `/handover` lets a human review the summary first, and `/intercom` opens the intercom overlay.

## Look up

- Mailbox, liveness, timeouts → [README: send vs ask](../../README.md#send-vs-ask)
- `confirmSend` and other settings → [README: Config](../../README.md#config)
- CLI scripting and other machines → [README: Scripting and Remote Machines](../../README.md#scripting-and-remote-machines)
- Extension channels for other extensions → [README: Extension channels](../../README.md#extension-channels)
