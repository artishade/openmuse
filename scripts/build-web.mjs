#!/usr/bin/env node
/**
 * Exports the Expo web bundle for the Freebuff preview with EXPO_PUBLIC_SAME_ORIGIN=1,
 * so the built app calls its own origin (the preview orchestrator proxies /api).
 */
import { spawnSync } from "node:child_process";

const result = spawnSync(
  "pnpm",
  [
    "--dir",
    "apps/mobile",
    "exec",
    "expo",
    "export",
    "--platform",
    "web",
    "--output-dir",
    "dist/web",
    "--clear",
  ],
  {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, EXPO_PUBLIC_SAME_ORIGIN: "1" },
  },
);
process.exit(result.status ?? 1);
