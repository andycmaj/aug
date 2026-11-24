// Where the generator's PRs live: the offline sim's state file, or a real
// GitHub repo it acts on as a GitHub App. Both take the same moves.

import type { Ask, GenPr } from "./plan";

// What a PR (or a follow-up push) changes: whole files, null to delete.
export interface Change {
  title: string;
  body: string;
  files: { path: string; content: string | null }[];
  // Where it came from: a replayed commit, or a planted change.
  source: string;
}

export interface Opened {
  number: number;
  url: string;
}

export interface GenTarget {
  name: string;
  // Whether a team is set up to ask (the generator asks it in turn).
  hasTeam: boolean;
  // Its own PRs: open ones, and those that closed lately.
  list(): Promise<GenPr[]>;
  open(change: Change, ask: Ask): Promise<Opened>;
  // Changes were asked: push the change on its branch, say so, ask again.
  followUp(pr: number, change: Change, reply: string): Promise<void>;
  // A comment on the PR, as its author.
  reply(pr: number, body: string): Promise<void>;
  // A comment tagging the owner.
  tag(pr: number, body: string): Promise<void>;
  // Ask the owner's review again, with nothing new.
  rerequest(pr: number): Promise<void>;
  merge(pr: number): Promise<void>;
  close(pr: number): Promise<void>;
}
