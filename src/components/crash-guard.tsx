// Every render error goes to the log; the framework's crash screen shows the
// message but keeps no record. Out of text buffers, the crash screen itself
// can't draw, so aug asks bin/aug for a fresh process instead of freezing.

import { ErrorBoundary, type ParentProps } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { logger } from "../core/log";
import { isOutOfTextBuffers, requestRestart } from "../core/restart";

const log = logger("ui");

export function CrashGuard(props: ParentProps) {
  const renderer = useRenderer();
  return (
    <ErrorBoundary
      fallback={(err: unknown, _reset: () => void) => {
        log.error("render error", { err });
        if (isOutOfTextBuffers(err)) {
          log.error("out of text buffers; restarting");
          requestRestart();
          // onDestroy (index.tsx) stops the engine and exits.
          queueMicrotask(() => renderer.destroy());
          return null;
        }
        // The framework's boundary above shows the crash screen.
        throw err;
      }}
    >
      {props.children}
    </ErrorBoundary>
  );
}
