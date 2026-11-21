// Where the library's warnings go: nowhere unless the caller says (aug hands
// it its own logger, so they land in aug.log).

export interface GuideLog {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

const silent: GuideLog = { warn() {} };
let current: GuideLog = silent;

export function setGuideLog(next: GuideLog | null): void {
  current = next ?? silent;
}

export const log: GuideLog = {
  warn: (msg, fields) => current.warn(msg, fields),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
