// Where the owner has been, like a browser's back and forward. A place is a
// selected row in Chat (its rail key) or the Board. In memory, one per run:
// rail keys are cheap to come back to, and a restart starts a fresh trail.
//
// The trail is the back/forward stack; going back and then somewhere new
// drops what was ahead, as a browser does. Recent is separate: every visit,
// back and forward included, moves a row to the front, so the numbers in
// the go-to list name the rows last seen whichever way you got there.

export type Place = { view: "chat"; key: string } | { view: "board" };

export const samePlace = (a: Place, b: Place): boolean =>
  a.view === b.view &&
  (a.view === "board" || (b.view === "chat" && a.key === b.key));

const TRAIL_MAX = 100;
const RECENT_MAX = 20;

export class NavHistory {
  private trail: Place[] = [];
  private at = -1;
  private recentKeys: string[] = [];

  current(): Place | null {
    return this.trail[this.at] ?? null;
  }

  // A visit. Landing where back or forward just put you is not a new one.
  visit(place: Place): void {
    this.touch(place);
    const here = this.current();
    if (here && samePlace(here, place)) return;
    this.trail = [...this.trail.slice(0, this.at + 1), place].slice(-TRAIL_MAX);
    this.at = this.trail.length - 1;
  }

  // The place before (or after) this one that still exists, if any; the
  // trail moves to it. Places that are gone (a task closed off the rail)
  // are stepped over, not dropped, so the trail keeps its shape.
  back(exists: (p: Place) => boolean = () => true): Place | null {
    return this.step(-1, exists);
  }

  forward(exists: (p: Place) => boolean = () => true): Place | null {
    return this.step(1, exists);
  }

  canGo(direction: 1 | -1, exists: (p: Place) => boolean = () => true): boolean {
    for (let i = this.at + direction; i >= 0 && i < this.trail.length; i += direction)
      if (exists(this.trail[i])) return true;
    return false;
  }

  // Rail keys most recently seen first, the current one left out.
  recent(): string[] {
    const here = this.current();
    const skip = here?.view === "chat" ? here.key : null;
    return this.recentKeys.filter((k) => k !== skip);
  }

  private step(direction: 1 | -1, exists: (p: Place) => boolean): Place | null {
    for (let i = this.at + direction; i >= 0 && i < this.trail.length; i += direction)
      if (exists(this.trail[i])) {
        this.at = i;
        this.touch(this.trail[i]);
        return this.trail[i];
      }
    return null;
  }

  private touch(place: Place): void {
    if (place.view !== "chat") return;
    this.recentKeys = [
      place.key,
      ...this.recentKeys.filter((k) => k !== place.key),
    ].slice(0, RECENT_MAX);
  }
}
