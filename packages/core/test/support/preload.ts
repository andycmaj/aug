// Tests start no entry point, so nothing has said where aug-tools is
// (core/self.ts): point at the real one, as the dev launcher would.
import { fileURLToPath } from "node:url";
import { setToolsEntry } from "../../src/self";

setToolsEntry(fileURLToPath(new URL("../../../cli/src/aug-tools.ts", import.meta.url)));
