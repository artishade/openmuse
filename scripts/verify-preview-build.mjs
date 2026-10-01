#!/usr/bin/env node
/** Verifies the preview web build exists before the orchestrator starts. */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const webDir = join(process.cwd(), "apps/mobile/dist/web");
const index = join(webDir, "index.html");
if (!existsSync(index)) {
  console.error(
    "[preview] expo export did not produce apps/mobile/dist/web/index.html — cannot serve the web app.",
  );
  process.exit(1);
}
const size = statSync(index).size;
console.log(`[preview] Web bundle OK: apps/mobile/dist/web/index.html (${size} bytes)`);
