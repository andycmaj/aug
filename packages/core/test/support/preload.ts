// Tests start no entry point, so nothing has said where riker-tools is
// (core/self.ts): point at the real one, as the dev launcher would.
import { fileURLToPath } from "node:url";
import { setToolsEntry } from "../../src/self";

setToolsEntry(fileURLToPath(new URL("../../../cli/src/riker-tools.ts", import.meta.url)));
