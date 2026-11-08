// A task's conversation as plain text, oldest first: what every agent (and
// the Assistant) reads back.

import { head } from "./docs";
import { TurnRole, type TurnRow } from "./types";

export function transcript(turns: TurnRow[]): string {
  return turns
    .map((turn) => {
      const at = turn.started_at.slice(0, 16).replace("T", " ");
      switch (turn.role) {
        case TurnRole.incoming:
          return `[${at}] ${turn.author} wrote:\n${head(turn.body, 3000)}`;
        case TurnRole.you:
          return `[${at}] The owner typed:\n${turn.body}`;
        case TurnRole.trigger:
          return `[${at}] (${turn.body})`;
        default: {
          const sent =
            turn.action_state === "sent"
              ? " (its draft was sent)"
              : turn.action_state === "retired"
                ? " (its draft was not sent)"
                : "";
          return `[${at}] You (the agent) answered${sent}:\n${turn.did ?? turn.body}\nNext steps: ${turn.next ?? ""}`;
        }
      }
    })
    .join("\n\n");
}
