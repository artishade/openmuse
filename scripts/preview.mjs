#!/usr/bin/env node
/**
 * Freebuff preview orchestrator for OpenMuse.
 *
 * Single origin on $PORT:
 *   - /            → apps/mobile/dist/web  (expo export --platform web)
 *   - /api/*       → proxied to the sample-mode API (127.0.0.1:8787) over the loopback.
 *
 * The API runs in sample mode (AGENT_BACKEND=sample), so no model provider keys are
 * needed for a working demo; only the CopilotKit Intelligence key is required by the
 * server's config validation in every mode.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { extname, join } from "node:path";

const port = Number(process.env.PORT || 3000);
const upstreamPort = Number(process.env.PREVIEW_API_PORT || 8787);
const webDir = join(process.cwd(), "apps/mobile/dist/web");
const hasWebBuild = existsSync(join(webDir, "index.html"));

if (!hasWebBuild) {
  console.error(
    "[preview] Missing apps/mobile/dist/web/index.html — run the build first: `pnpm build:preview`.",
  );
  process.exit(1);
}

// ---------- static file serving ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webp": "image/webp",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".otf": "font/otf",
};

function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  // Reject path traversal before touching the filesystem.
  const resolved = join(webDir, pathname);
  if (!resolved.startsWith(webDir)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  let filePath = resolved;
  if (!existsSync(filePath) || !filePath.startsWith(webDir)) {
    // SPA fallback → app shell (Expo web uses client routing).
    filePath = join(webDir, "index.html");
  }
  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
      "Cache-Control": filePath.endsWith("index.html") ? "no-store" : "public, max-age=3600",
    });
    res.end(body);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

// ---------- /api proxy ----------
function proxy(req, res) {
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: req.url,
      method: req.method,
      // Forward the public Host: the API treats an Origin matching it as same-origin.
      headers: { ...req.headers },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `The API is starting up: ${error.message}` }));
  });
  req.pipe(upstream);
}

const server = createServer((req, res) => {
  if (req.url.startsWith("/api/")) proxy(req, res);
  else if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, preview: true }));
  } else serveStatic(req, res);
});

// ---------- child processes ----------
const children = [];
function start(name, command, args, env, readyProbe) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[preview] ${name} exited with code ${code}; shutting down.`);
      shutdown();
    }
  });
  return { name, port: readyProbe };
}

start(
  "api",
  process.execPath,
  ["--import", "tsx", "apps/server/src/index.ts"],
  {
    PORT: String(upstreamPort),
    HOST: "127.0.0.1",
    PUBLIC_API_URL: `http://127.0.0.1:${upstreamPort}`,
    WORKSPACE_MODE: "sample",
    AGENT_BACKEND: "sample",
    ALLOWED_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
    DATA_DIR: ".openmuse",
    TASK_WORKER_ENABLED: "true",
    DO_NOT_TRACK: "1",
    COPILOTKIT_TELEMETRY_DISABLED: "true",
  },
  upstreamPort,
);

server.listen(port, "0.0.0.0", async () => {
  // The API boots embedded PGlite, which takes a while; report ready only once it answers.
  const ready = await waitForApi();
  console.log(
    ready
      ? `[preview] OpenMuse ready on http://0.0.0.0:${port} (API → 127.0.0.1:${upstreamPort})`
      : `[preview] API has not answered /api/health yet; serving the web app only.`,
  );
});

async function waitForApi(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shuttingDown) return false;
    try {
      const response = await fetch(`http://127.0.0.1:${upstreamPort}/api/health`);
      if (response.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

// ---------- lifecycle ----------
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
