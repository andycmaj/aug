import { beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "../src/engine";
import { setMux } from "../src/mux";
import { readFolds, writeFolds } from "../src/rail";
import * as store from "../src/store";
import { FakeMux } from "./support/fake-mux";
import { fakeBrain, freshHome, testConfig } from "./support/helpers";

let engine: Engine;

beforeEach(() => {
  freshHome({ repos: {} });
  fakeBrain(() => null);
  setMux(new FakeMux());
  engine = new Engine({ config: testConfig() });
});

const project = (name: string) =>
  store.createProject({ name, tmuxSession: name });

// A restart is a new desk over the same database.
const restart = () => new Engine({ config: testConfig() }).desk;

describe("the rail's folded projects outlive a restart", () => {
  test("a folded project comes back folded, the others open", () => {
    const a = project("ledger");
    const b = project("billing");
    engine.desk.setFoldedProjects(new Set([a.id]));
    expect([...restart().foldedProjects()]).toEqual([a.id]);
    expect(restart().foldedProjects().has(b.id)).toBe(false);
  });

  test("an unfold is kept too", () => {
    const a = project("ledger");
    engine.desk.setFoldedProjects(new Set([a.id]));
    engine.desk.setFoldedProjects(new Set());
    expect(restart().foldedProjects().size).toBe(0);
  });

  test("a project archived or deleted since drops out", () => {
    const a = project("ledger");
    const b = project("billing");
    const c = project("ops");
    engine.desk.setFoldedProjects(new Set([a.id, b.id, c.id]));
    store.archiveProject(a.id);
    store.deleteProject(b.id);
    expect([...restart().foldedProjects()]).toEqual([c.id]);
    // and is not written back on the next save
    restart().setFoldedProjects(new Set([a.id, c.id]));
    expect(store.kvGet("rail.folded")).toBe(JSON.stringify([c.id]));
  });

  test("a renamed project stays folded", () => {
    const a = project("ledger");
    engine.desk.setFoldedProjects(new Set([a.id]));
    store.updateProject(a.id, { name: "ledger v2" });
    expect(restart().foldedProjects().has(a.id)).toBe(true);
  });

  test("a project made since opens unfolded", () => {
    const a = project("ledger");
    engine.desk.setFoldedProjects(new Set([a.id]));
    const b = project("new one");
    const folds = restart().foldedProjects();
    expect(folds.has(a.id)).toBe(true);
    expect(folds.has(b.id)).toBe(false);
  });
});

describe("readFolds", () => {
  test("nothing saved, or junk, is nothing folded", () => {
    expect(readFolds(null, [1]).size).toBe(0);
    expect(readFolds("not json", [1]).size).toBe(0);
    expect(readFolds('{"a":1}', [1]).size).toBe(0);
    expect([...readFolds('[1,"2",null,3]', [1, 2, 3])]).toEqual([1, 3]);
  });

  test("round trips through writeFolds", () => {
    expect([...readFolds(writeFolds([3, 1]), [1, 2, 3])]).toEqual([1, 3]);
  });
});
