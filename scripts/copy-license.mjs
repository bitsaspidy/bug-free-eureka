// Copies the root LICENSE into the package being packed (run from the package dir via prepack).
import { copyFileSync } from "node:fs";
import { resolve } from "node:path";

copyFileSync(resolve(import.meta.dirname, "..", "LICENSE"), resolve(process.cwd(), "LICENSE"));
