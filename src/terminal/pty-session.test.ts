import { expect, test } from "bun:test";
import { PtySession } from "./pty-session";

// Output already in flight arrives after kill; the owner has torn down its
// emulator by then, so feeding it crashes the app.
test("no data is delivered after kill", async () => {
  let killed = false;
  let late = 0;
  let first: () => void = () => {};
  const started = new Promise<void>((resolve) => (first = resolve));
  const session = new PtySession(["sh", "-c", "while :; do echo spam; done"], {
    cols: 80,
    rows: 24,
    onData: () => {
      if (killed) late++;
      first();
    },
    onExit: () => {},
  });
  await started;
  session.kill();
  killed = true;
  await new Promise((r) => setTimeout(r, 200));
  expect(late).toBe(0);
});
