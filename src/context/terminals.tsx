// Every embedded terminal: coding agents (one per session) and one-off
// editors ($EDITOR on a draft or a doc). Sessions and their renderables live
// here, not in a pane, so they survive a pane remounting or the view
// switching; a host box adopts the renderable when it
// mounts and gives it back when it goes.

import {
  createSignal,
  onCleanup,
  type Accessor,
  type ParentProps,
} from "solid-js";
import type { BoxRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createRequiredContext, useTheme } from "@andycmaj/opentui-app";
import { PtySession } from "../terminal/pty-session";
import { TerminalModes } from "../terminal/modes";
import { terminalReplies } from "../terminal/replies";
import { ViewportTerminalRenderable } from "../terminal/viewport-terminal";

export interface TermRequest {
  id: string;
  title: string;
  kind: "agent" | "editor";
  taskId?: number;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  onExit?: (code: number | null) => void;
}

export interface TermState {
  id: string;
  title: string;
  kind: TermRequest["kind"];
  taskId?: number;
  running: boolean;
  exitCode: number | null;
}

interface Term {
  request: TermRequest;
  view: ViewportTerminalRenderable;
  session: PtySession;
  host: BoxRenderable | null;
  size: { cols: number; rows: number };
}

interface TerminalsValue {
  list: Accessor<TermState[]>;
  get: (id: string) => TermState | undefined;
  forTask: (taskId: number) => TermState | undefined;
  open: (request: TermRequest) => void;
  write: (id: string, data: string) => void;
  close: (id: string) => void;
  // A host box adopts the session's renderable and sizes it; returns the
  // release function for onCleanup.
  adopt: (id: string, host: BoxRenderable) => () => void;
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

  const publish = () =>
    setList(
      [...terms.values()].map((t) => ({
        id: t.request.id,
        title: t.request.title,
        kind: t.request.kind,
        taskId: t.request.taskId,
        running: t.session.running,
        exitCode: t.session.exitCode,
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
      size: { cols, rows },
      host: null,
      session: null as unknown as PtySession,
    };
    term.session = new PtySession(request.argv, {
      cols,
      rows,
      cwd: request.cwd,
      env: request.env,
      onData: (data) => {
        view.feed(data);
        const text = decoder.decode(data, { stream: true });
        modes.feed(text);
        const replies = terminalReplies(text, {
          cursor: view.term.getCursor(),
          foreground: isHex(theme.text) ? theme.text : "#c0c0c0",
          background: isHex(theme.background) ? theme.background : "#000000",
        });
        if (replies) term.session.write(replies);
      },
      onExit: (code) => {
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
        close,
        adopt,
      }}
    >
      {props.children}
    </TerminalsContext.Provider>
  );
}
