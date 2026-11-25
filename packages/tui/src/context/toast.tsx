// Toasts: a passing word (info, gone after its duration) and errors, which
// stay until the owner dismisses them with Esc, since one that fades on its
// own is often gone before it is read. Errors stack, newest on top: the
// toast shows the newest and how many wait under it, and each Esc dismisses
// one. The same error again counts on the newest rather than stacking.
// opentui-app's own toast is one slot on a timer for every variant; this
// keeps its showToast(message, duration, variant) so callers read the same.

import {
  createSignal,
  onCleanup,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { createRequiredContext } from "@andycmaj/opentui-app";

export const ToastVariant = { info: "info", error: "error" } as const;
export type ToastVariant = (typeof ToastVariant)[keyof typeof ToastVariant];

export interface InfoToast {
  id: number;
  message: string;
}

export interface ErrorToast {
  id: number;
  message: string;
  // How many times it was raised in a row (1 the first time).
  times: number;
}

export interface Toasts {
  info: Accessor<InfoToast | null>;
  // Oldest first: the last is the one shown, and the one Esc dismisses.
  errors: Accessor<ErrorToast[]>;
  // `duration` is the info toast's; an error ignores it.
  showToast: (message: string, duration?: number, variant?: ToastVariant) => void;
  // The newest error; false when none is up.
  dismissError: () => boolean;
  clearToast: () => void;
  dispose: () => void;
}

const INFO_MS = 2000;
// Past this many the oldest go: a loop raising errors must not grow it forever.
export const MAX_ERRORS = 20;

export function createToasts(): Toasts {
  const [info, setInfo] = createSignal<InfoToast | null>(null);
  const [errors, setErrors] = createSignal<ErrorToast[]>([]);
  let nextId = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stopTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const showToast = (
    message: string,
    duration = INFO_MS,
    variant: ToastVariant = ToastVariant.info,
  ) => {
    const id = ++nextId;
    if (variant === ToastVariant.error) {
      setErrors((list) => {
        const top = list[list.length - 1];
        if (top?.message === message)
          return [...list.slice(0, -1), { ...top, id, times: top.times + 1 }];
        return [...list, { id, message, times: 1 }].slice(-MAX_ERRORS);
      });
      return;
    }
    stopTimer();
    setInfo({ id, message });
    // Guard on the id so a stale timer never clears a newer toast.
    timer = setTimeout(() => {
      setInfo((now) => (now?.id === id ? null : now));
      timer = null;
    }, duration);
  };

  const dismissError = () => {
    if (errors().length === 0) return false;
    setErrors((list) => list.slice(0, -1));
    return true;
  };

  const clearToast = () => {
    stopTimer();
    setInfo(null);
    setErrors([]);
  };

  return { info, errors, showToast, dismissError, clearToast, dispose: stopTimer };
}

const [ToastContext, useToast] = createRequiredContext<Toasts>("Toast");
export { useToast };

export function ToastProvider(props: ParentProps) {
  const toasts = createToasts();
  onCleanup(toasts.dispose);
  return <ToastContext.Provider value={toasts}>{props.children}</ToastContext.Provider>;
}
