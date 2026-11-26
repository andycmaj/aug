// Whether marks animate (core/link-state.ts motionOn). The RikerProvider
// gives config's say; a piece mounted without one (a terminal in a test)
// reads the environment alone.

import { createContext, useContext, type Accessor } from "solid-js";
import { motionOn } from "@riker/core/link-state";

export const MotionContext = createContext<Accessor<boolean>>(() =>
  motionOn({}),
);
export const useMotion = () => useContext(MotionContext);
