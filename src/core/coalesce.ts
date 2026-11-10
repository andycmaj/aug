// Many calls, one run: the first schedule() starts a short timer and later
// calls ride along, so a burst of store writes redraws the UI once. flush()
// runs a pending call now, for code that reads the redrawn state right after
// writing it.

export interface Coalesced {
  schedule(): void;
  flush(): void;
  cancel(): void;
}

export function coalesce(fn: () => void, ms = 16): Coalesced {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    fn();
  };
  return {
    schedule() {
      if (timer === null) timer = setTimeout(flush, ms);
    },
    flush,
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
