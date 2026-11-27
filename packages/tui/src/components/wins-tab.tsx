// The Wins tab: the day and the day before it, newest first, each with its Wins and how they
// came out, then what else landed or moved. Today and yesterday by default;
// h and l walk the pair back and forth a day. Enter opens a row in place
// (the day's events, turns, moves, PR and agent time); t goes to the task;
// z pins an earlier day's open Win as one of today's again.

import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { truncate, useTheme } from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useRiker } from "../context/riker";
import { localDay, MAX_WINS } from "@riker/core/rail";
import { prChip } from "@riker/core/pr";
import { taskRef } from "@riker/core/rows";
import { tokens, usd } from "@riker/core/spend";
import { TurnRole, type TaskRow, type TurnRow } from "@riker/core/types";
import {
  carriesOver,
  eventWords,
  Outcome,
  shiftDay,
  type DayRow,
  type WinDetail,
  type WinsDay,
} from "@riker/core/wins-board";
import type { Actions } from "./actions";
import {
  ExpandList,
  listCursor,
  selColor,
  type ListEntry,
} from "./expand-list";
import { clock, toneColor, useLaneMeta } from "./ui";

type Handler = () => false | void;

// One selectable line: a task on a day, as a Win or as also done.
interface WinsLine {
  key: string;
  day: string;
  row: DayRow;
}

// Kept across tab switches, like the Board's tab. null is today, so the
// tab follows the clock past midnight.
const [focusDay, setFocusDay] = createSignal<string | null>(null);
const cursor = listCursor();

const OUTCOME_LOOK: Record<
  Outcome,
  { mark: string; word: string; tone: "success" | "accent" | "muted" | "text" }
> = {
  done: { mark: "✓", word: "done", tone: "success" },
  merged: { mark: "»", word: "merged", tone: "accent" },
  dropped: { mark: "✗", word: "dropped", tone: "muted" },
  later: { mark: "◷", word: "for later", tone: "muted" },
  open: { mark: "•", word: "still open", tone: "text" },
};

export function useWinsTab(opts: { active: () => boolean; actions: Actions }) {
  const riker = useRiker();
  const today = () => localDay(riker.now());
  const day = () => focusDay() ?? today();
  const days = createMemo((): WinsDay[] =>
    opts.active()
      ? [
          riker.winsDay(day(), riker.now()),
          riker.winsDay(shiftDay(day(), -1), riker.now()),
        ]
      : [],
  );
  const lines = createMemo((): WinsLine[] =>
    days().flatMap((d) =>
      [...d.wins, ...d.also].map((row) => ({
        key: `${d.day}:${row.task.id}`,
        day: d.day,
        row,
      })),
    ),
  );
  const line = (): WinsLine | null =>
    lines()[cursor.index(lines().length)] ?? null;

  const move = (d: number) => cursor.move(d, lines().length);

  const shift = (by: number) => {
    const next = shiftDay(day(), by);
    if (next > today()) {
      return false;
    }
    setFocusDay(next === today() ? null : next);
    cursor.reset();
  };

  const onLine =
    (fn: (l: WinsLine) => false | void): Handler =>
    () => {
      if (!opts.active()) {
        return false;
      }
      const l = line();
      if (!l) {
        return false;
      }
      return fn(l);
    };

  const fresh = (l: WinsLine): DayRow => ({
    ...l.row,
    task: riker.task(l.row.task.id) ?? l.row.task,
  });
  const todayWins = createMemo(() =>
    opts.active()
      ? riker.winsDay(today(), riker.now()).wins.map((r) => r.task.id)
      : [],
  );
  const carries = (l: WinsLine | null): boolean =>
    Boolean(
      l && carriesOver(fresh(l), l.day, { day: today(), wins: todayWins() }),
    );

  const commands: Record<string, Handler> = {
    [Commands.WINS_EXPAND]: onLine((l) => cursor.toggle(l.key)),
    [Commands.WINS_GO]: onLine((l) => opts.actions.goToTask(l.row.task.id)),
    [Commands.WINS_CARRY]: onLine((l) =>
      carries(l) ? opts.actions.carryWin(fresh(l).task) : false,
    ),
    [Commands.WINS_PREV_DAY]: () => (opts.active() ? shift(-1) : false),
    [Commands.WINS_NEXT_DAY]: () =>
      opts.active() && focusDay() ? shift(1) : false,
    [Commands.WINS_TODAY]: () => {
      if (!opts.active() || !focusDay()) {
        return false;
      }
      setFocusDay(null);
      cursor.reset();
    },
  };

  const task = (): TaskRow | null => {
    const l = opts.active() ? line() : null;
    return l ? (riker.task(l.row.task.id) ?? l.row.task) : null;
  };

  return {
    commands,
    task,
    move,
    ctx: () => ({
      winsToday: focusDay() === null,
      winCarry: opts.active() && carries(line()),
    }),
    View: (props: { width: number }) => (
      <WinsView
        days={days()}
        selected={line()?.key ?? null}
        openKey={cursor.openKey()}
        today={today()}
        width={props.width}
        canCarry={lines().some((l) => carries(l))}
      />
    ),
  };
}

function dayTitle(day: string, today: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  if (day === today) {
    return `Today · ${date}`;
  }
  if (day === shiftDay(today, -1)) {
    return `Yesterday · ${date}`;
  }
  return date;
}

// What a row says after its title: how it came out (or, today, where it
// is now) and what happened that day.
function rowSays(row: DayRow): string {
  // The outcome column already says merged or dropped.
  const happened = row.events
    .filter(
      (e) =>
        e.kind !== "created" && !(e.kind === row.outcome && e.kind !== "done"),
    )
    .map(eventWords);
  const talk = [
    row.you ? `${row.you} from you` : null,
    row.agent ? `${row.agent} agent turn${row.agent === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return [...new Set(happened), ...talk].join(" · ");
}

function WinsView(props: {
  days: WinsDay[];
  selected: string | null;
  openKey: string | null;
  today: string;
  width: number;
  canCarry: boolean;
}) {
  const theme = useTheme();
  const lane = useLaneMeta();

  const heading = (
    key: string,
    text: string,
    extra?: string,
  ): ListEntry<WinsLine> => ({
    key,
    heading: () => (
      <text marginTop={1}>
        <span style={{ fg: theme.accent, attributes: 1 }}>{text}</span>
        <Show when={extra}>
          <span style={{ fg: theme.textMuted }}>{`  ${extra}`}</span>
        </Show>
      </text>
    ),
  });
  const quiet = (key: string, text: string): ListEntry<WinsLine> => ({
    key,
    heading: () => (
      <box paddingLeft={2}>
        <text fg={theme.textMuted}>{text}</text>
      </box>
    ),
  });

  // Each day: its title, its Wins, then what else got done.
  const entries = createMemo((): ListEntry<WinsLine>[] =>
    props.days.flatMap((d, i) => {
      const done = d.wins.filter((w) => w.outcome === Outcome.done).length;
      const rows = (list: DayRow[]) =>
        list.map((row) => ({
          row: { key: `${d.day}:${row.task.id}`, day: d.day, row },
        }));
      const title: ListEntry<WinsLine> = {
        key: `${d.day}:title`,
        heading: (): JSX.Element => (
          <text fg={theme.primary} attributes={1} marginTop={i === 0 ? 0 : 2}>
            {dayTitle(d.day, props.today)}
          </text>
        ),
      };
      return [
        title,
        heading(
          `${d.day}:wins`,
          `Wins ${d.wins.length ? `${done}/${d.wins.length}` : ""}`.trim(),
          d.isToday && d.wins.length < MAX_WINS
            ? `${MAX_WINS - d.wins.length} more can be pinned: z on a rail row`
            : undefined,
        ),
        ...(d.wins.length
          ? rows(d.wins)
          : [
              quiet(
                `${d.day}:no-wins`,
                d.isToday
                  ? "No Wins pinned today. z on a rail row pins one (up to 5)."
                  : "No Wins were pinned this day.",
              ),
            ]),
        heading(
          `${d.day}:also`,
          d.isToday ? "Also done today" : "Also done",
          [
            d.made ? `${d.made} task${d.made === 1 ? "" : "s"} made` : null,
            d.moves
              ? `${d.moves} move${d.moves === 1 ? "" : "s"} by the Assistant and agents`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined,
        ),
        ...(d.also.length
          ? rows(d.also)
          : [
              quiet(
                `${d.day}:no-also`,
                "Nothing else closed, merged or talked over.",
              ),
            ]),
      ];
    }),
  );

  // Today a Win still open says its lane; otherwise how it came out.
  const look = (r: DayRow) => {
    if (r.lane && r.outcome === Outcome.open) {
      const meta = lane(r.lane);
      return {
        mark: meta.mark,
        word: meta.word,
        color: toneColor(theme, meta.tone),
      };
    }
    const o = OUTCOME_LOOK[r.outcome];
    return { mark: o.mark, word: o.word, color: toneColor(theme, o.tone) };
  };
  const titleWidth = () => Math.max(16, Math.min(56, props.width - 70));

  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} paddingLeft={1}>
      <box flexDirection="row" gap={2} flexShrink={0} paddingBottom={1}>
        <text fg={theme.textMuted}>
          {[
            "h the day before",
            props.days[0]?.isToday ? null : "l the day after · 0 today",
            props.canCarry ? "z on an open Win: win today" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </text>
      </box>
      <ExpandList
        id="wins"
        entries={entries()}
        rowKey={(l) => l.key}
        selected={props.selected}
        openKey={props.openKey}
        indent={1}
        paddingRight={2}
        row={(l, sel) => {
          const fg = selColor(theme, sel);
          const lk = look(l.row);
          return (
            <>
              <text fg={fg(lk.color)} width={2} flexShrink={0}>
                {lk.mark}
              </text>
              <text fg={fg(theme.textMuted)} width={8} flexShrink={0}>
                {taskRef(l.row.task.id)}
              </text>
              <text fg={fg(theme.text)} width={titleWidth()} flexShrink={0}>
                {truncate(l.row.task.title, titleWidth())}
              </text>
              <text fg={fg(lk.color)} width={22} flexShrink={0}>
                {truncate(lk.word, 22)}
              </text>
              <text fg={fg(theme.textMuted)} flexGrow={1}>
                {truncate(
                  rowSays(l.row),
                  Math.max(10, props.width - titleWidth() - 46),
                )}
              </text>
            </>
          );
        }}
        detail={(l) => (
          <Detail taskId={l.row.task.id} day={l.day} width={props.width} />
        )}
      />
    </box>
  );
}

function turnLine(t: TurnRow): string {
  const first = (s: string | null) =>
    (s ?? "")
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  const who =
    t.role === TurnRole.you
      ? "you"
      : t.role === TurnRole.agent
        ? "agent"
        : t.role === TurnRole.incoming
          ? t.author || "in"
          : "riker";
  const what =
    t.role === TurnRole.agent
      ? first(t.did) || first(t.about) || first(t.body)
      : first(t.body);
  return `${clockCol(t.started_at)}${who}: ${what}`;
}

// A clock column: "9:00 AM" and "11:00 AM" line up.
function clockCol(iso: string): string {
  return clock(iso).padStart(8) + "  ";
}

function hours(ms: number): string {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// The open row: what the task is, its PR, and what happened to it that day.
function Detail(props: { taskId: number; day: string; width: number }) {
  const theme = useTheme();
  const riker = useRiker();
  const detail = createMemo((): WinDetail | null =>
    riker.winDetail(props.taskId, props.day),
  );
  const width = () => Math.max(20, props.width - 10);
  const sub = (text: string) => (
    <text fg={theme.secondary} marginTop={1}>
      {text}
    </text>
  );
  return (
    <Show when={detail()}>
      {(d: () => WinDetail) => {
        const summary = () =>
          d()
            .task.summary.split("\n")
            .filter((l) => l.trim())
            .slice(0, 3)
            .join(" ");
        const pr = () => d().pr;
        return (
          <box
            flexDirection="column"
            paddingLeft={4}
            paddingTop={1}
            paddingBottom={1}
            backgroundColor={theme.contentPane}
          >
            <text fg={theme.text} wrapMode="word">
              {summary() ? truncate(summary(), width() * 3) : "(no brief)"}
            </text>
            <text fg={theme.textMuted}>
              {truncate(
                [
                  d().task.kind,
                  d().task.repo,
                  d().task.branch ? `branch ${d().task.branch}` : null,
                  pr()
                    ? pr()!.status
                      ? `PR ${pr()!.pr.repo}#${pr()!.pr.number} ${prChip(pr()!.status!).text}`
                      : `PR ${pr()!.pr.repo}#${pr()!.pr.number} (not read yet)`
                    : null,
                  d().agentMs > 0
                    ? `agent ran ${hours(d().agentMs)} this day`
                    : null,
                  d().spend.calls
                    ? `${usd(d().spend.cost)} · ${tokens(d().spend.tokens)} tok`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                width(),
              )}
            </text>
            <Show when={d().events.length > 0}>
              {sub("What happened")}
              <For each={d().events}>
                {(e) => (
                  <text fg={theme.text}>
                    {truncate(
                      `${clockCol(e.at)}${eventWords(e)}${e.kind === "finished" && e.detail ? `: ${e.detail}` : ""}`,
                      width(),
                    )}
                  </text>
                )}
              </For>
            </Show>
            {sub(
              d().turns.length
                ? `Chat and agent${d().moreTurns ? ` (newest ${d().turns.length}, ${d().moreTurns} older)` : ""}`
                : "Chat and agent",
            )}
            <For
              each={d().turns}
              fallback={<text fg={theme.textMuted}>No turns this day.</text>}
            >
              {(t) => (
                <text
                  fg={t.role === TurnRole.agent ? theme.text : theme.textMuted}
                >
                  {truncate(turnLine(t), width())}
                </text>
              )}
            </For>
            <Show when={d().moves.length > 0}>
              {sub("Moves")}
              <For each={d().moves}>
                {(m) => (
                  <text fg={theme.textMuted}>
                    {truncate(
                      `${clockCol(m.created_at)}${m.asked_by}: ${m.verb}${m.result ? ` → ${m.result}` : ""}`,
                      width(),
                    )}
                  </text>
                )}
              </For>
            </Show>
            <text fg={theme.textMuted} marginTop={1}>
              t go to task · Enter close
            </text>
          </box>
        );
      }}
    </Show>
  );
}
