// The sidebar's foot: each connection's state in one line, like tilt-tui's
// connection status, drawn by LinkMark: animated while it connects, the
// reason beside a failure.

import { For } from "solid-js";
import { useRiker } from "../context/riker";
import { foldConnector, type Link } from "@riker/core/link-state";
import type { ConnectorStatus } from "@riker/core/engine";
import { usd } from "@riker/core/spend";
import { LinkMark } from "./link-mark";

// The tracked link, or the status read as one before the first change.
export function linkOf(
  links: Record<string, Link>,
  name: string,
  s: ConnectorStatus,
): Link {
  return links[name] ?? foldConnector(null, s, Date.now());
}

// Today's spend on Riker's own model calls, against the cap when one is on:
// warning from 80% of it, error once reached (Riker's own turns wait then).
export function spendWords(
  spent: number,
  cap: number | null,
): {
  text: string;
  level: "ok" | "near" | "capped";
} {
  if (cap === null) {
    return { text: `${usd(spent)} today`, level: "ok" };
  }
  return {
    text: `${usd(spent)}/${usd(cap)} today`,
    level: spent >= cap ? "capped" : spent >= cap * 0.8 ? "near" : "ok",
  };
}

export function ConnectorLine() {
  const riker = useRiker();
  // const spend = () =>
  //   spendWords(
  //     riker.spendOn(localDay(riker.now())).cost,
  //     dailyCap(riker.desk.config()),
  //   );
  const rows = () =>
    riker.engine.connections().flatMap((c) => {
      const s = riker.status()[c.name];
      // A quiet one is shown once it is turned on.
      if (!s || (c.quietWhenOff && s.state === "off")) {
        return [];
      }
      return [{ name: c.name, link: linkOf(riker.links(), c.name, s) }];
    });
  return (
    <box
      flexDirection="row"
      padding={1}
      paddingLeft={2}
      paddingRight={2}
      flexShrink={0}
      gap={2}
    >
      <For each={rows()}>
        {(r) => (
          <text>
            <LinkMark link={r.link} label={r.name} reason />
          </text>
        )}
      </For>
      {/* spend section. hide until we have a better design 
      <text
        fg={
          spend().level === "capped"
            ? theme.error
            : spend().level === "near"
              ? theme.warning
              : theme.textMuted
        }
      >
        {spend().text}
      </text> */}
    </box>
  );
}
