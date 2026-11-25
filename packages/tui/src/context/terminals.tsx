// Every embedded terminal: coding agents (one per session), one-off
// editors ($EDITOR on a draft or a doc) and ghdash on a task's PR. Sessions and their renderables live
// here, not in a pane, so they survive a pane remounting or the view
// switching; a host box adopts the renderable when it
// mounts and gives it back when it goes.

import {
  createSignal,
  onCleanup,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { RGBA, type BoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createRequiredContext, useTheme } from "@andycmaj/opentui-app";
import { PtySession } from "../terminal/pty-session";
import { TerminalModes } from "../terminal/modes";
import { readClipboard } from "../terminal/clipboard";
import { terminalReplies } from "../terminal/replies";
import { ViewportTerminalRenderable } from "../terminal/viewport-terminal";
import { LinkTracker, type Link } from "@riker/core/link-state";

// How much of the background a veiled terminal shows through: enough that
// it reads as asleep, not so much that it cannot be read.
export const VEIL_ALPHA = 0.5;

// tmux attach, an editor or ghdash draws within a second; one silent this
// long reads failed (it still connects if output comes later).
export const TERM_CONNECT_MS = 15_000;

export interface TermRequest {
  id: string;
  title: string;
  kind: "agent" | "editor" | "ghdash" | "review";
  taskId?: number;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  onExit?: (code: number | null) => void;
  // How long it may stay silent before it reads failed; TERM_CONNECT_MS.
  connectMs?: number;
}

export interface TermState {
  id: string;
  title: string;
  kind: TermRequest["kind"];
  taskId?: number;
  running: boolean;
  exitCode: number | null;
  // Connecting from spawn until its first output; failed when it exits
  // before any, or stays silent past TERM_CONNECT_MS.
  link: Link;
}

interface Term {
  request: TermRequest;
  view: ViewportTerminalRenderable;
  session: PtySession;
  link: LinkTracker;
  modes: TerminalModes;
  host: BoxRenderable | null;
  size: { cols: number; rows: number };
}

interface TerminalsValue {
  list: Accessor<TermState[]>;
  get: (id: string) => TermState | undefined;
  forTask: (taskId: number) => TermState | undefined;
  open: (request: TermRequest) => void;
  write: (id: string, data: string) => void;
  // Pasted text, wrapped the way the program in the session asked for.
  paste: (id: string, text: string) => void;
  close: (id: string) => void;
  // A host box adopts the session's renderable and sizes it; returns the
  // release function for onCleanup.
  adopt: (id: string, host: BoxRenderable) => () => void;
  // The terminal whose host passes every key to it, if any: the footer and
  // help show only its own keys then. A host claims it while attached and
  // running; the claim returns its release.
  attached: Accessor<string | null>;
  claimKeys: (id: string) => () => void;
  // Greys a terminal's screen out while it is shown but not attached, so it
  // is plain that typing does not go to it.
  veil: (id: string, on: boolean) => void;
}

const [TerminalsContext, useTerminals] =
  createRequiredContext<TerminalsValue>("Terminals");
export { useTerminals };

function isHex(color: string | undefined): color is string {
  return Boolean(color && /^#[0-9a-f]{6}/i.test(color));
}

export function TerminalsProvider(props: ParentProps) {
  const renderer = useRenderer();
  const theme = useTheme();
  const dims = useTerminalDimensions();
  const terms = new Map<string, Term>();
  const [list, setList] = createSignal<TermState[]>([]);
  const [attached, setAttached] = createSignal<string | null>(null);

  const publish = () =>
    setList(
      [...terms.values()].map((t) => ({
        id: t.request.id,
        title: t.request.title,
        kind: t.request.kind,
        taskId: t.request.taskId,
        running: t.session.running,
        exitCode: t.session.exitCode,
        link: t.link.link,
      })),
    );

  function fit(term: Term) {
    const host = term.host;
    if (!host || host.width <= 0 || host.height <= 0) return;
    const cols = Math.max(10, host.width);
    const rows = Math.max(3, host.height);
    if (cols === term.size.cols && rows === term.size.rows) return;
    term.size = { cols, rows };
    term.view.resizeTerminal(cols, rows);
    term.session.resize(cols, rows);
  }

  function open(request: TermRequest) {
    const existing = terms.get(request.id);
    if (existing?.session.running) return;
    if (existing) close(request.id);
    // Start near the size it will be shown at so the program does not draw
    // for 80x24 and then reflow; the host refits on adopt.
    const cols = Math.max(40, dims().width - 50);
    const rows = Math.max(10, dims().height - 10);
    const view = new ViewportTerminalRenderable(renderer, {
      cols,
      rows,
      flexGrow: 1,
    });
    const decoder = new TextDecoder();
    const modes = new TerminalModes();
    const term: Term = {
      request,
      view,
      modes,
      size: { cols, rows },
      host: null,
      session: null as unknown as PtySession,
      // Publishes only once the term is listed: open publishes after.
      link: new LinkTracker({
        timeoutMs: request.connectMs ?? TERM_CONNECT_MS,
        onChange: () => terms.get(request.id) === term && publish(),
      }),
    };
    term.link.connecting();
    term.session = new PtySession(request.argv, {
      cols,
      rows,
      cwd: request.cwd,
      env: request.env,
      onData: (data) => {
        if (term.link.link.phase !== "connected") term.link.connected();
        view.feed(data);
        const text = decoder.decode(data, { stream: true });
        modes.feed(text);
        const replies = terminalReplies(text, {
          cursor: view.term.getCursor(),
          foreground: isHex(theme.text) ? theme.text : "#c0c0c0",
          background: isHex(theme.background) ? theme.background : "#000000",
          clipboard: readClipboard,
        });
        if (replies) term.session.write(replies);
      },
      onExit: (code) => {
        if (term.link.link.phase !== "connected")
          term.link.failed(`exited ${code ?? "?"} before any output`);
        term.link.dispose();
        publish();
        request.onExit?.(code);
      },
    });
    // A program that takes the wheel scrolls itself (Claude Code fullscreen
    // keeps its transcript off our scrollback); otherwise scroll ours.
    view.onMouseScroll = (event) => {
      const direction = event.scroll?.direction;
      if (direction !== "up" && direction !== "down") return;
      event.stopPropagation();
      const bytes = modes.wheel(direction, event.x - view.x, event.y - view.y);
      if (bytes) {
        view.followBottom();
        term.session.write(bytes);
      } else view.scrollLines(direction === "up" ? -3 : 3);
    };
    terms.set(request.id, term);
    publish();
  }

  function close(id: string) {
    const term = terms.get(id);
    if (!term) return;
    term.session.kill();
    term.link.dispose();
    if (term.host) term.host.remove(term.view);
    term.view.destroyTerminal();
    terms.delete(id);
    publish();
  }

  function adopt(id: string, host: BoxRenderable): () => void {
    const term = terms.get(id);
    if (!term) return () => {};
    if (term.host && term.host !== host) term.host.remove(term.view);
    term.host = host;
    host.add(term.view);
    term.size = { cols: 0, rows: 0 };
    const refit = () => fit(term);
    // Layout is not computed until the first frame.
    const start = () => {
      if (host.isDestroyed) return;
      if (host.width <= 0 || host.height <= 0) {
        setTimeout(start, 16);
        return;
      }
      refit();
    };
    start();
    host.onSizeChange = refit;
    return () => {
      if (term.host === host) {
        if (!host.isDestroyed) host.remove(term.view);
        term.host = null;
      }
    };
  }

  onCleanup(() => {
    for (const id of [...terms.keys()]) close(id);
  });

  return (
    <TerminalsContext.Provider
      value={{
        list,
        get: (id) => list().find((t) => t.id === id),
        forTask: (taskId) =>
          list().find((t) => t.kind === "agent" && t.taskId === taskId),
        open,
        write: (id, data) => {
          const term = terms.get(id);
          if (!term) return;
          // Typing returns to the live screen, as in any terminal.
          term.view.followBottom();
          term.session.write(data);
        },
        paste: (id, text) => {
          const term = terms.get(id);
          if (!term || !text) return;
          term.view.followBottom();
          term.session.write(term.modes.paste(text));
        },
        close,
        adopt,
        attached,
        claimKeys: (id) => {
          setAttached(id);
          return () => setAttached((cur) => (cur === id ? null : cur));
        },
        veil: (id, on) => {
          const term = terms.get(id);
          if (!term) return;
          const bg = isHex(theme.background) ? theme.background : "#000000";
          const color = RGBA.fromHex(bg);
          color.a = VEIL_ALPHA;
          term.view.setVeil(on ? color : null);
        },
      }}
    >
      {props.children}
    </TerminalsContext.Provider>
  );
}
