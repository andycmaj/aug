import { beforeEach, expect, test } from "bun:test";
import { localDay } from "@riker/core/rail";
import * as store from "@riker/core/store";
import { Verdict } from "@riker/core/types";
import { config, fakeBrain, freshHome } from "@riker/core/test/support/helpers";
import { askVerdict } from "../src/triage";

beforeEach(() => freshHome());

test("triage's model call is spent as triage", async () => {
  fakeBrain(
    () => ({ verdict: Verdict.fyi, reason: "x", title: "x", summary: "x", priority: "regular" }),
    { costUsd: 0.1 },
  );
  const m = store.insertMessage({
    channel: "slack",
    externalId: "slack:C1:1",
    threadKey: "slack:C1:1",
    author: "U9",
    authorName: "Ruth",
    title: "#eng",
    body: "fyi",
    receivedAt: new Date().toISOString(),
    meta: { channel: "C1", ts: "1" },
  })!;
  await askVerdict(m, [m], null, config());
  expect(store.spendByRole(localDay(new Date())).map((r) => r.role)).toEqual(["triage"]);
});
