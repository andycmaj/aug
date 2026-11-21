// What drawing costs: each rendered frame's time and how many cells it
// changed (churn at idle shows up as cells), and how long the first screen
// took from process start. Only while perf is on.
//
// The frame time is measured here, from the frame callbacks (run before the
// tree renders) to the frame event (after the native render and the write):
// the renderer's own nativeLastFrameTime is not in ms.

import { onCleanup } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { perfOn, sample, timing } from "@aug/core/perf";

export function useRenderPerf(): void {
  if (!perfOn()) return;
  const renderer = useRenderer();
  let first = true;
  let frameStart: number | null = null;
  const onStart = async () => {
    frameStart = performance.now();
  };
  const onFrame = () => {
    const end = performance.now();
    if (first) {
      first = false;
      // performance.now() counts from process start.
      timing("startup.first_frame", end);
    }
    if (frameStart !== null) timing("render.frame", end - frameStart);
    frameStart = null;
    sample("render.cells", renderer.getNativeStats().cellsUpdated, "cells");
  };
  renderer.setFrameCallback(onStart);
  renderer.on("frame", onFrame);
  onCleanup(() => {
    renderer.removeFrameCallback(onStart);
    renderer.off("frame", onFrame);
  });
}
