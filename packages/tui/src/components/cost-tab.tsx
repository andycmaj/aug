// The Board's Cost tab: what Riker's own model calls cost today and this week,
// by role and by task, against the daily cap (config.spend). The same
// numbers as riker-tools spend.

import { For, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { truncate, useTheme, type ThemeColor } from "@andycmaj/opentui-app";
import { useRiker } from "../context/riker";
import { tokens, usd } from "@riker/core/spend";
import { taskRef } from "@riker/core/rows";
import type { SpendTotal } from "@riker/core/types";

const BAR = 16;

// A bar of `value` out of `max`, BAR cells wide.
export function costBar(value: number, max: number, width = BAR): string {
  const full = max > 0 ? Math.min(width, Math.round((value / max) * width)) : 0;
  return `${"█".repeat(full)}${"░".repeat(width - full)}`;
}

function Row(props: {
  label: string;
  total: SpendTotal;
  max: number;
  color: ThemeColor;
  extra?: string;
  width: number;
}) {
  const theme = useTheme();
  return (
    <text>
      <span style={{ fg: theme.text }}>{props.label.padEnd(12)}</span>
      <span style={{ fg: props.color }}>
        {costBar(props.total.cost, props.max)}
      </span>
      <span
        style={{ fg: theme.text }}
      >{` ${usd(props.total.cost).padStart(8)}`}</span>
      <span style={{ fg: theme.textMuted }}>
        {`  ${String(props.total.calls).padStart(4)} calls  ${tokens(props.total.tokens).padStart(5)} tok${props.extra ? `  ${truncate(props.extra, Math.max(10, props.width - 60))}` : ""}`}
      </span>
    </text>
  );
}

export function CostTab(props: {
  width: number;
  scrollRef: (r: ScrollBoxRenderable) => void;
}) {
  const riker = useRiker();
  const theme = useTheme();
  const report = () => riker.spendReport(riker.desk.config(), riker.now());
  const capped = () => {
    const r = report();
    return r.cap !== null && r.today.cost >= r.cap;
  };
  const near = () => {
    const r = report();
    return r.cap !== null && r.today.cost >= r.cap * 0.8;
  };
  const tone = () =>
    capped() ? theme.error : near() ? theme.warning : theme.success;
  const max = (rows: SpendTotal[]) => Math.max(0, ...rows.map((r) => r.cost));
  const title = (id: number) => riker.task(id)?.title ?? "(gone)";
  const heading = (text: string) => (
    <text fg={theme.primary} attributes={1} marginTop={1}>
      {text}
    </text>
  );

  return (
    <scrollbox
      ref={props.scrollRef}
      flexGrow={1}
      flexBasis={0}
      paddingLeft={1}
      paddingRight={2}
    >
      <text>
        <span style={{ fg: theme.text, attributes: 1 }}>
          {`Today ${report().day}  ${usd(report().today.cost)}`}
        </span>
        <span style={{ fg: theme.textMuted }}>
          {report().cap === null
            ? "  · no daily cap"
            : `  of ${usd(report().cap ?? 0)} cap`}
          {`  · ${report().today.calls} calls · ${tokens(report().today.tokens)} tokens`}
        </span>
      </text>
      <Show when={report().cap !== null}>
        <text>
          <span style={{ fg: tone() }}>
            {costBar(report().today.cost, report().cap ?? 0, 40)}
          </span>
          <span style={{ fg: capped() ? theme.error : theme.textMuted }}>
            {capped()
              ? "  reached: turns Riker starts by itself wait; yours still run"
              : `  ${usd(Math.max(0, (report().cap ?? 0) - report().today.cost))} left`}
          </span>
        </text>
      </Show>

      {heading("By role, today")}
      <For
        each={report().byRole}
        fallback={<text fg={theme.textMuted}>No model calls yet today.</text>}
      >
        {(r) => (
          <Row
            label={r.role}
            total={r}
            max={max(report().byRole)}
            color={theme.info}
            width={props.width}
          />
        )}
      </For>

      {heading("Tasks, today")}
      <For
        each={report().tasksToday}
        fallback={
          <text fg={theme.textMuted}>No task's agent has run today.</text>
        }
      >
        {(t) => (
          <Row
            label={taskRef(t.task_id)}
            total={t}
            max={max(report().tasksToday)}
            color={theme.secondary}
            extra={title(t.task_id)}
            width={props.width}
          />
        )}
      </For>

      {heading("Last 7 days")}
      <For
        each={report().week}
        fallback={<text fg={theme.textMuted}>Nothing recorded this week.</text>}
      >
        {(d) => (
          <Row
            label={d.day}
            total={d}
            max={Math.max(max(report().week), report().cap ?? 0)}
            color={
              report().cap !== null && d.cost >= (report().cap ?? 0)
                ? theme.error
                : theme.success
            }
            width={props.width}
          />
        )}
      </For>

      {heading("Tasks, this week")}
      <For
        each={report().tasksWeek}
        fallback={<text fg={theme.textMuted}>None.</text>}
      >
        {(t) => (
          <Row
            label={taskRef(t.task_id)}
            total={t}
            max={max(report().tasksWeek)}
            color={theme.secondary}
            extra={title(t.task_id)}
            width={props.width}
          />
        )}
      </For>

      <text fg={theme.textMuted} marginTop={1} wrapMode="word">
        Headless calls only (triage, the Assistant, general agents, the Advisor,
        Slack): a coding agent's cost shows in its own Claude Code status line.
        The cap is spend.dailyUsd in config.json; spend.capEnabled turns it off.
      </text>
    </scrollbox>
  );
}
