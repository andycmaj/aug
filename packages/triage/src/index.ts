// Triage as a plugin: the engine's inbox worker calls next(), the desk's
// r and m call again() and fromHeld(), and every fresh message is offered
// to arrived() first. Core knows only the Triage interface (core/plugins.ts).

import type { RikerPlugin, Triage } from "@riker/core/plugins";
import { heldVerdict, linkByBranch, taskFromHeld, triage } from "./triage";
import { triageNext } from "./worker";

export function triageJudge(): Triage {
  return {
    arrived: (message) => void linkByBranch(message),
    next: (config) => triageNext({ config }),
    again: (message, config) => triage(message, { config }),
    fromHeld: (message, config) => {
      const answer = heldVerdict(message.id);
      return answer ? taskFromHeld(message, answer, config) : null;
    },
  };
}

export function triagePlugin(): RikerPlugin {
  return { name: "triage", triage: triageJudge() };
}
