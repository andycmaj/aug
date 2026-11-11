import { describe, expect, test } from "bun:test";
import { defaultHome } from "../src/core/paths";
import { demoHome } from "../src/fixtures/demo";

describe("demo home", () => {
  test("a home you named is the demo's", () => {
    expect(demoHome({ AUG_HOME: "/tmp/my-demo" })).toBe("/tmp/my-demo");
  });

  test("never aug's own home: not the real one, not from an agent's window", () => {
    expect(demoHome({})).toContain("aug-demo-");
    expect(demoHome({ AUG_HOME: defaultHome() })).toContain("aug-demo-");
    expect(demoHome({ AUG_HOME: `${defaultHome()}/` })).toContain("aug-demo-");
    expect(demoHome({ AUG_HOME: "/tmp/scratch-aug", AUG: "1" })).toContain("aug-demo-");
  });
});
