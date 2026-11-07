# TODO: an air-traffic-control view for the Board

Status: idea, not started.

The Board today has Columns, Wall, Live handoffs and Hub. An approach
controller has the same problem the owner has: many things in motion, each
owned by someone, each heading toward the one place it needs attention, and
one person whose attention is the bottleneck. This note proposes a **Radar**
tab and lists the other parts of ATC practice that could carry over to
task, agent and assistant orchestration.

## 1. Task radar (the view)

A fifth Board tab, `5 Radar`.

The scope is a set of concentric rings. **The center is you.** A task's
distance from the center says how soon it needs you, and it moves inward as
its state changes. The rings take the place of the Board's columns:

| Ring (inside out) | Lanes                      | ATC analogue                  |
| ----------------- | -------------------------- | ----------------------------- |
| 0 (center)        | `blocked`, `approve`       | on final, needs a clearance   |
| 1                 | `asked`, `agentdone`       | on approach, expecting you    |
| 2                 | `working`, `yours`         | en route, under control       |
| 3                 | `queued`, `stopped`, `saved` | holding, or on the ground   |
| 4 (edge)          | `theirs`, `watching`, `later` | outbound, someone else's  |
| off the scope     | `done`                     | landed / radar service ends   |

- **Angle is the sector.** Bearing comes from where the work lives: one
  wedge per repo for GitHub, per channel for Slack, and one for your own
  to-dos. Tasks from one repo cluster together, so trouble in one place shows
  up as a crowded wedge.
- **Movement.** When a task changes lane it animates to its new ring over a
  few frames, so the eye catches it. A short **history trail** (2–3 faint
  dots at its earlier positions) shows which way it is heading.
- **Data block.** Each blip has a label joined by a leader line, as on a
  real scope: `AUG-0006 ◆ 10h`, which is the ref, the lane mark and the age.
  Priority sets the color, and `slipped` blinks.
- **Rendering.** Draw the rings with braille cells (2×4 dots per cell). A
  terminal cell is about twice as tall as wide, so the x radius has to be
  twice the y radius to look round. Labels will collide near the center, so
  use a simple declutter pass that tries the label in 8 positions around the
  blip and keeps the first that doesn't overlap.
- **Keys.**
  - `j`/`k` step through blips by distance, innermost first: the most
    urgent first, the same order as `n`.
  - `h`/`l` rotate between sectors.
  - `enter` opens the task in Chat.
  - `s`, `S` and `d` work as they do on Columns.
  - `ctrl+i` shows info.
- **Open questions.**
  - Is a wide terminal (≥120 cols) required, and is there a fallback for
    narrow ones?
  - Does ring 0 get crowded enough to need its own zoomed "final approach"
    list beside the scope?

## 2. Other ATC practice worth stealing

Ordered roughly by how cheaply each could be built on what aug already has.

### Flight progress strips → the Board's columns, with a "next logical action"

Paper strips move bay to bay as a flight progresses. Electronic strip
systems added a **Next Logical Action** button: one press does whatever
naturally comes next for that strip in its current state. aug's columns are
already strip bays.

**Proposal:** a single key (`.`) that does the next logical move for the lane:
- send in `approve`;
- answer in `blocked`;
- start in `queued`;
- read and clear in `agentdone`;
- done in `yours`.

Controllers also **cock a strip**, sliding it sideways to flag it without
moving it. That maps to a sticky "flag" on a rail row, separate from
priority.

### Handoff vs point-out → owner/agent transfers

A **handoff** transfers control of a flight. A **point-out** only makes
another controller aware of it, and control does not move. The handing
controller passes the details in a fixed order: identity, any
restrictions, deviation from the cleared route, then anything else that
matters.

**Proposal:**
- Make agent→owner and owner→agent transfers explicit handoffs that use that
  fixed brief: who it is, what it may not do, where it has strayed from the
  brief, what else matters.
- Add a "point-out" for telling another agent or person about a task without
  giving it to them. It would be a cheaper sibling of the Live handoffs
  notes.

### Position relief briefing → coming back to the desk

When one controller relieves another, they walk an ordered checklist, never
rushed, with **traffic always the last item** so it is freshest.

**Proposal:** after an idle gap (lunch, overnight), offer a relief brief
built in that order:
1. connection status;
2. what you set (NOTAMs, below);
3. what changed in watched threads;
4. last, the live traffic: blocked and approve first.

This is a structured version of the morning digest that v1 left out. The
same shape works for an agent resuming a saved session.

### Arrival manager and metering → pacing what lands on you

AMAN sequences arrivals and gives each a target time, so the runway is used
smoothly and nobody has to hold in a stack. A Ground Delay Program goes
further: if the destination can't take a flight, it is held *on the ground at
the origin*, where waiting is cheap, instead of in the air, where it burns
fuel.

**Proposal:** treat your review capacity as the runway.
- Meter how fast drafts reach `approve`, and give queued agents target
  times.
- Don't start an agent whose result you can't review today. Its draft only
  goes stale, and it burns tokens: the airborne-holding cost.
- `maxActiveAgents` is a crude version of this already.

### Holding stacks and EFC → For later

A held flight is always given an **Expect Further Clearance** time, so
nobody holds without knowing when they'll move.

**Proposal:**
- Every `later`, `theirs` and `queued` task always shows its EFC: the
  remind time, the expected reply, or its place in the queue.
- A task waiting past its EFC is a soft alarm, which generalizes `slipped`.

### Conflict alert (STCA) → predicted collisions between tasks

STCA warns about a predicted loss of separation, typically about a minute
before it happens, with a blinking alert.

**Proposal:** a conflict detector that flags:
- two agents working the same repo or files at once;
- two drafts going to the same person or thread;
- a draft whose thread got a new message after it was written: the
  situation changed under it (a "deviation");
- a reply about to go to a different channel than the thread it came from.

These show as blinking pairs on the radar and as a banner on the table.

### Squawk codes and lost comms → agent liveness

Emergency squawks are 7700 (emergency), 7600 (radio failure) and 7500
(hijack). Lost-comms procedures mean a silent aircraft still behaves
predictably.

**Proposal:**
- An agent with no hook events for N minutes is "squawking 7600": it is
  marked on the radar.
- Each kind of agent gets a defined lost-comms procedure, such as "save and
  stop after 20 silent minutes" or "keep going but send nothing".
- An agent that tries a tool outside its allow list is the 7500 analogue:
  stop it and surface it.

### Readback / hearback → confirmation both ways

A pilot reads every clearance back, and the controller listens for errors.

**Proposal:**
- aug's Send confirm is already the readback for outbound words.
- Add the reverse: before a long coding run, the agent reads back its
  one-line understanding of the brief, and the owner acks it or corrects it.

### ATIS and NOTAMs → versioned context for agents

ATIS broadcasts current conditions under a letter ("information Bravo"), and
pilots report which letter they have. NOTAMs are temporary notices with an
expiry.

**Proposal:**
- Stamp each docs/LEARNED.md version with a letter. Agents report the letter
  they started with, so a long-running agent on stale guidance is visible.
- Add short-lived NOTAMs alongside the permanent LEARNED.md, such as "main is
  frozen until Friday" or "don't ping Ruth today". They expire on their own
  and are shown in the relief brief.

### Flight plan and deviation → brief vs. actual

A flight files a plan, and the controller watches for deviation from the
cleared route.

**Proposal:**
- The coding brief is the flight plan.
- Flag when an agent's tool steps leave the expected area, such as files
  outside the named paths or a different repo.
- On the radar, a deviating blip leaves its sector wedge.

### Sector combine/split → workload modes

Facilities combine sectors when traffic is light and split them when it is
heavy.

**Proposal:** a "busy" mode that folds FYI and Watching away and only
lets `blocked`/`approve` interrupt. Quiet hours do the reverse.

### Fuel → token budget

"Minimum fuel" earns a flight priority before it becomes an emergency.

**Proposal:**
- Give each agent a token or time budget.
- Nearing it raises the task's priority so you see it before it runs dry,
  instead of it silently stopping.

## Sources

- [SKYbrary: Flight Progress Strips](https://skybrary.aero/articles/flight-progress-strips)
- [Saab: Electronic Flight Strips (next logical action, bay-to-bay)](https://www.saab.com/products/electronic-flight-strips-EFS)
- [FAA JO 7110.65, Appendix D: Position relief briefing](https://www.faa.gov/air_traffic/publications/atpubs/ATC/AppdxD.html)
- [FAA JO 7110.65 §5-4: Transfer of radar identification (handoffs, point-outs)](https://www.faa.gov/air_traffic/publications/atpubs/ATC/atc0504.html)
- [FAA JO 7110.65 §5-13: Automation, conflict alert](https://www.faa.gov/air_traffic/publications/atpubs/atc_html/chap5_section_13.html)
- [Frequentis: AMAN product brief](https://www.frequentis.com/sites/default/files/support/2023-09/AMAN_product_brief_ATM_Frequentis.pdf)
- [ICAO/FAA: ATFM tools to balance demand with capacity (GDP)](https://www.icao.int/sites/default/files/APAC/Meetings/2025/2025%20Capacity%20Assessment%20WS/Day%204/SP-16-ATFM-Tools-to-Balance-Demand-with-Capacity-FAA.pdf)
- [vATSys: track display (data blocks, leader lines, history trails)](https://virtualairtrafficsystem.com/docs/tracks/)
