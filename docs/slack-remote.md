# Talking to the Assistant from Slack

AUG-0102. The owner drives aug away from the terminal by writing in a Slack
conversation only they are in. aug hears each line as if it was typed in
Home, and posts the Assistant's answer back in that message's thread.

Code: `src/core/slack/remote.ts` (what is heard, what is answered),
`src/core/slack/remote-links.ts` (token and claude-mcp reads and posts),
`Engine.startRemote` / `pollRemote`.

## Which conversation

Either of these works:

- **Your self-DM** (the "you" DM in Slack). With a token, aug finds it on its
  own (`conversations.open` with your own id). Under claude-mcp, put its id
  (`D...`) in `remote.channel`.
- **A private channel with only you in it.** Make it, leave it with one
  member, and put its id in `remote.channel`. It is easier to find on a phone
  than the self-DM, and it keeps aug's answers apart from notes to self.

aug checks the members on every read. If anyone else is in it, or it is a
public channel (anyone can join), it hears nothing and the status line says
why. Adding someone turns the remote off until they leave.

## Transport

Polling, the same as the triage poller, and on the same `slack.transport`:

- **token** (`SLACK_TOKEN`, a user token): `conversations.history` on the one
  conversation, `conversations.replies` on threads live in the last 24 hours
  (at most 10), every 15 s. Cheap: a few Web API calls per tick. Replies are
  `chat.postMessage` with `thread_ts`. Scopes: `im:history`, `im:read` (or
  `groups:history`, `groups:read` for a private channel), `chat:write`.
- **claude-mcp** (the claude.ai Slack connector): a second long-lived
  read-only `claude -p` session for this conversation alone, every 60 s
  (each read is a model turn). Replies go through the existing one-shot send
  call, whose only tool is the send tool.

Socket Mode and the Events API were set aside: both need a Slack app with a
bot and a public or tunnelled endpoint or an app-level token, and a bot is not
told about your self-DM. Polling one conversation is cheap and needs nothing
new.

Both links post as the owner, so a read sees aug's answers under the owner's
own id. Every answer starts with `[aug]`, and aug remembers the ts of what it
posted (token), so it never hears itself.

## What is heard

Only lines that pass every gate:

- the conversation is the owner's alone (above);
- written by the owner's own user id;
- not a bot or app message, no subtype (joins, edits, file shares), except
  a thread reply also sent to the channel;
- not empty, not starting with `[aug]`;
- newer than the moment the remote first listened: turning it on never
  replays an old "yes".

What is not heard is logged by ts and reason only; message text never reaches
the log.

## Routing

A heard line goes through `desk.say` to Home, author `you via Slack`, so it is
the owner talking to the Assistant: the same `claude -p` session, the same
tools (aug-tools and gh reads), the same rules (it never sends anything to
anyone, asks before anything that ends work). The transcript tells the
Assistant the line came from Slack, so it answers in a few short lines.

Home is one conversation, so a reply in a thread continues it, and so does a
new top-level message. The thread only says where the answer goes. The first
finished Assistant turn after the line is its answer; it is posted in the
line's thread (`**bold**` and headings turned into Slack's `*bold*`, cut at
3500 characters with a pointer to Home). A line heard while a turn was
running gets a turn of its own on the next tick. A line with no answer after
an hour gets a short "no answer" note.

## Confirmations

Today: the Assistant already asks before anything that ends work or cannot be
undone, and only starts or stops agents when asked. In Slack that ask is its
answer in the thread, and the owner's "yes" in the same thread is the next
line it hears, inside the same conversation. Since only the owner can write
in the conversation, a yes there is the owner's.

Next, if that is not enough: a hard gate for moves made in a turn that
answers a Slack line (`AUG_ASKED_BY=assistant-slack`). `stop`, `start`,
`done` and archive answer `needs confirm <code>` instead of running; the
Assistant posts "Reply yes to stop AUG-0012", and the owner's next line in that
thread, if it is a yes within 10 minutes, runs the stored move. A
confirmation older than 10 minutes, or answered with anything else, is
dropped and says so.

## Notifications (not built)

Optional, `remote.notify: ["finished", "waiting"]`: a top-level `[aug]` post
in the same conversation when a coding agent finishes (`workFinished`) or is
waiting for the owner (AUG-0101's waiting-for-you state). One line each, the
task's ref and title; replying in its thread talks to the Assistant about
that task (the post names the ref, so the Assistant reads it in). At most one
post per task per state change.

## Setup

`~/.aug/config.json`:

```json
{
  "remote": { "enabled": true, "channel": "D0123ABCD" }
}
```

- `enabled`: off by default. Turning it on needs a restart of aug; turning
  it off takes effect on the next tick.
- `channel`: the self-DM or private channel. Optional with a token.
- `pollSeconds`: 15 with a token, 60 under claude-mcp.

It is separate from `slack.enabled`: the triage poller can stay off (the
owner's JOB doc keeps it off for now) while the remote runs. When both run,
the triage poller drops anything from the remote's conversation.

Status shows as `remote` on the connector line once it is turned on, and in
the status dialog. When Slack cannot be reached, or the conversation is not
private, the status is an error with the reason, nothing is lost (the cursor
does not move, an unposted answer waits), and the next tick tries again.

## Tokens

- `slackApi` logs only the method and status.
- `claudeEnv` drops `SLACK_TOKEN`, so no agent's shell (coding, chat, the
  Assistant) sees it. A token kept in `config.json` is still a file an agent
  could read: keep it in `SLACK_TOKEN`.
- Nothing about the token goes into a prompt.

## Limits under claude-mcp

The members and the author ids come from the reader model's answer, not from
the API, so the per-message gates are a second line there; the first is that
the owner picked a conversation only they can write in. The send call is told
the channel and the exact text; an answer that quotes hostile text from a task
could in principle try to talk that call into posting elsewhere. The token
link has neither limit.
