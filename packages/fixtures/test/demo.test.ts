import { describe, expect, test } from "bun:test";
import { defaultHome } from "@riker/core/paths";
import { demoHome } from "../src/demo";

describe("demo home", () => {
  test("a home you named is the demo's", () => {
    expect(demoHome({ RIKER_HOME: "/tmp/my-demo" })).toBe("/tmp/my-demo");
  });

  test("never Riker's own home: not the real one, not from an agent's window", () => {
    expect(demoHome({})).toContain("riker-demo-");
    expect(demoHome({ RIKER_HOME: defaultHome() })).toContain("riker-demo-");
    expect(demoHome({ RIKER_HOME: `${defaultHome()}/` })).toContain(
      "riker-demo-",
    );
    expect(
      demoHome({ RIKER_HOME: "/tmp/scratch-riker", RIKER: "1" }),
    ).toContain("riker-demo-");
  });
});
