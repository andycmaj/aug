// Where a run is, for whoever shows it: the diff read into batches, the one
// whole call, each batch as it is sent and answered, the chapters call; then
// (saveGuide) the notes fitted and the guide saved into Plannotator.
export const GuideStage = {
  read: "read",
  whole: "whole",
  batches: "batches",
  chapters: "chapters",
  fitting: "fitting",
  saving: "saving",
} as const;

export type GuideProgress =
  | { stage: typeof GuideStage.read; files: number; batches: number }
  | { stage: typeof GuideStage.whole }
  | {
      stage: typeof GuideStage.batches;
      done: number;
      running: number;
      of: number;
    }
  | { stage: typeof GuideStage.chapters; of: number }
  | { stage: typeof GuideStage.fitting }
  | { stage: typeof GuideStage.saving };
