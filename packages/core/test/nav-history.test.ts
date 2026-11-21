import { expect, test } from "bun:test";
import { NavHistory, type Place } from "../src/nav-history";

const chat = (key: string): Place => ({ view: "chat", key });
const board: Place = { view: "board" };

test("back and forward walk the trail like a browser", () => {
  const h = new NavHistory();
  h.visit(chat("t1"));
  h.visit(chat("t2"));
  h.visit(board);
  expect(h.back()).toEqual(chat("t2"));
  expect(h.back()).toEqual(chat("t1"));
  expect(h.back()).toBeNull();
  expect(h.forward()).toEqual(chat("t2"));
  expect(h.forward()).toEqual(board);
  expect(h.forward()).toBeNull();
});

test("landing where back put you is not a new visit", () => {
  const h = new NavHistory();
  h.visit(chat("t1"));
  h.visit(chat("t2"));
  const p = h.back()!;
  h.visit(p);
  expect(h.forward()).toEqual(chat("t2"));
});

test("going somewhere new after back drops what was ahead", () => {
  const h = new NavHistory();
  h.visit(chat("t1"));
  h.visit(chat("t2"));
  h.back();
  h.visit(chat("t3"));
  expect(h.forward()).toBeNull();
  expect(h.back()).toEqual(chat("t1"));
});

test("a place that is gone is stepped over", () => {
  const h = new NavHistory();
  h.visit(chat("t1"));
  h.visit(chat("t2"));
  h.visit(chat("t3"));
  const exists = (p: Place) => !(p.view === "chat" && p.key === "t2");
  expect(h.canGo(-1, exists)).toBe(true);
  expect(h.back(exists)).toEqual(chat("t1"));
  expect(h.canGo(-1, exists)).toBe(false);
  expect(h.forward(exists)).toEqual(chat("t3"));
});

test("recent is most recently seen first, without the current row", () => {
  const h = new NavHistory();
  h.visit(chat("t1"));
  h.visit(chat("t2"));
  h.visit(board);
  h.visit(chat("t3"));
  h.visit(chat("t1"));
  expect(h.recent()).toEqual(["t3", "t2"]);
  // Back counts as seeing it.
  h.back();
  expect(h.recent()).toEqual(["t1", "t2"]);
  // On the Board, every row is a candidate.
  h.visit(board);
  expect(h.recent()).toEqual(["t3", "t1", "t2"]);
});
