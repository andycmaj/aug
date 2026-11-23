// docs/keyboard.html carries the keymap as data: it must match the table, so
// a key added or moved without `bun run docs:keys` fails here.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Commands } from "../src/commands";
import { keysDoc, withKeysData } from "../src/keys-doc";

const page = join(import.meta.dir, "../../../docs/keyboard.html");

test("docs/keyboard.html is up to date with the keymap (bun run docs:keys)", () => {
  const html = readFileSync(page, "utf8");
  expect(withKeysData(html)).toBe(html);
});

// Each place lists what the footer would there, so spot-check the ones the
// page's chords and notes lean on.
test("the places list the keys that work there", () => {
  const doc = keysDoc();
  const place = (id: string) => {
    const p = doc.places.find((x) => x.id === id);
    if (!p) throw new Error(`no place ${id}`);
    return new Map(p.rows.map((r) => [r.cmd, r.keys]));
  };
  const attached = place("attached");
  expect(attached.get(Commands.TERMINAL_BACK)).toBe("^o / ^[");
  expect(attached.get(Commands.GO_HOME)).toBe("^a");
  expect(attached.has(Commands.WALK_NEXT)).toBe(false);
  const typing = place("typing");
  expect(typing.get(Commands.INPUT_LEAVE)).toBe("esc");
  expect(typing.has(Commands.DONE)).toBe(false);
  expect(place("home").has(Commands.GO_HOME)).toBe(false);
  expect(place("dialog").get(Commands.GO_BACK)).toBe("^o / ^[");
  expect(place("rail-task").get(Commands.SEND)).toBe("y");
});
