/**
 * End-to-end smoke test for the AI Robot Assistant cloud API.
 *
 * Assumes `apps/api` is running locally (default http://localhost:3000) with a
 * Postgres reachable via DATABASE_URL. The script is tolerant to both a fresh
 * DB (bootstraps on the fly) and one already seeded: the bootstrap step
 * accepts either a successful creation or a 409 "AlreadyBootstrapped".
 *
 * Run: `pnpm smoke` (or `tsx scripts/smoke.ts`).
 *
 * The script also acts as a mock BLE bridge: it opens a WebSocket to
 * `/ws/bridge` using the freshly minted bridge token, replies to scan requests
 * with an empty device list, and therefore allows `/api/bridges/:id/scan` to
 * succeed without any real hardware.
 */
import WebSocket from "ws";
import type {
  AgentDTO,
  BridgeDTO,
  BridgeDownMsg,
  BridgeUpMsg,
  SessionDTO,
  TvDownMsg,
} from "../packages/shared/src/index.js";

// ---------- Config ----------

interface Cli {
  apiUrl: string;
  bridgeUrl: string;
}

function parseCli(argv: string[]): Cli {
  // Defaults come from env, then hard-coded fallbacks. --flag overrides both.
  let apiUrl = process.env.API_URL ?? "http://localhost:3000";
  let bridgeUrl = process.env.BRIDGE_URL ?? "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--api-url" && argv[i + 1]) {
      apiUrl = argv[i + 1]!;
      i++;
    } else if (a === "--bridge-url" && argv[i + 1]) {
      bridgeUrl = argv[i + 1]!;
      i++;
    }
  }
  if (!bridgeUrl) {
    // Derive ws://host/ws/bridge from http(s)://host.
    bridgeUrl =
      apiUrl.replace(/^http/, "ws").replace(/\/$/, "") + "/ws/bridge";
  }
  return { apiUrl, bridgeUrl };
}

const cli = parseCli(process.argv.slice(2));
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@example.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "change-me";

// ---------- ANSI colors (no chalk dep) ----------

const C = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
} as const;

// ---------- Step runner ----------

interface StepResult {
  n: number;
  label: string;
  ok: boolean;
  ms: number;
  message?: string;
}

const results: StepResult[] = [];

async function step<T>(
  n: number,
  label: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const value = await fn();
    const ms = Date.now() - t0;
    results.push({ n, label, ok: true, ms });
    process.stdout.write(
      `${C.green}[PASS]${C.reset} ${n}. ${label} ${C.dim}(${ms}ms)${C.reset}\n`,
    );
    return value;
  } catch (err) {
    const ms = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    results.push({ n, label, ok: false, ms, message });
    process.stdout.write(
      `${C.red}[FAIL]${C.reset} ${n}. ${label}: ${message} ${C.dim}(${ms}ms)${C.reset}\n`,
    );
    return undefined;
  }
}

function warn(msg: string): void {
  process.stdout.write(`${C.yellow}[WARN]${C.reset} ${msg}\n`);
}

// ---------- HTTP helpers ----------

/**
 * REST helper with optional Bearer auth. Throws on non-2xx/3xx with a short
 * message including status and response body for easy debugging.
 */
async function apiFetch(
  path: string,
  init: RequestInit = {},
  token?: string,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(cli.apiUrl + path, { ...init, headers });
}

async function readJson<T>(res: Response): Promise<T> {
  // Response types are loosely typed from the server; cast is intentional at
  // this single choke point.
  const txt = await res.text();
  try {
    return JSON.parse(txt) as T;
  } catch {
    throw new Error(`expected JSON, got: ${txt.slice(0, 200)}`);
  }
}

function expectStatus(res: Response, ...allowed: number[]): void {
  if (!allowed.includes(res.status)) {
    throw new Error(`HTTP ${res.status} (expected ${allowed.join("/")})`);
  }
}

// ---------- WS helpers ----------

/** Wait for the next message on `ws` matching `predicate` or time out. */
function waitForMessage<T>(
  ws: WebSocket,
  predicate: (msg: unknown) => msg is T,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error(`timeout waiting for ${label}`));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (predicate(parsed)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(parsed);
      }
    };
    ws.on("message", onMessage);
  });
}

function isBridgeDown(x: unknown): x is BridgeDownMsg {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as { type?: unknown }).type === "string"
  );
}

function isTvDown(x: unknown): x is TvDownMsg {
  return isBridgeDown(x);
}

function isAdminFrame(x: unknown): x is { type: string; [k: string]: unknown } {
  return isBridgeDown(x);
}

// ---------- Main flow ----------

async function main(): Promise<number> {
  const t0 = Date.now();
  process.stdout.write(`Smoke test: ${cli.apiUrl}\n`);

  // 1. Health.
  await step(1, "GET /healthz", async () => {
    const res = await fetch(cli.apiUrl + "/healthz");
    expectStatus(res, 200);
  });

  // 2. Bootstrap is idempotent: 201/200 on first call, 409 if already done.
  await step(2, "POST /api/auth/bootstrap (idempotent)", async () => {
    const res = await apiFetch("/api/auth/bootstrap", { method: "POST" });
    if (![200, 201, 409].includes(res.status)) {
      expectStatus(res, 200, 201, 409);
    }
  });

  // 3. Login — this gates everything else. Hard fail if missing.
  const token = await step(3, "POST /api/auth/login", async () => {
    const res = await apiFetch("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expectStatus(res, 200);
    const body = await readJson<{ token: string }>(res);
    if (!body.token) throw new Error("no token in response");
    return body.token;
  });
  if (!token) return 1;

  // 4. List agents (may be empty on fresh DB).
  await step(4, "GET /api/agents", async () => {
    const res = await apiFetch("/api/agents", {}, token);
    expectStatus(res, 200);
    const body = await readJson<AgentDTO[]>(res);
    if (!Array.isArray(body)) throw new Error("expected array");
  });

  // 5. Create agent. Body matches the route's zod CreateAgentSchema minimum.
  const agent = await step(5, "POST /api/agents (create)", async () => {
    const res = await apiFetch(
      "/api/agents",
      {
        method: "POST",
        body: JSON.stringify({
          name: "smoke-agent",
          personality: "teste",
          systemPrompt: "teste",
          voice: "alloy",
        }),
      },
      token,
    );
    expectStatus(res, 201);
    const body = await readJson<AgentDTO>(res);
    if (!body.id) throw new Error("no agent id");
    return body;
  });
  if (!agent) return 1;

  // 6. Rename via PATCH.
  await step(6, "PATCH /api/agents/:id (rename)", async () => {
    const newName = `smoke-agent-${Date.now()}`;
    const res = await apiFetch(
      `/api/agents/${agent.id}`,
      { method: "PATCH", body: JSON.stringify({ name: newName }) },
      token,
    );
    expectStatus(res, 200);
    const body = await readJson<AgentDTO>(res);
    if (body.name !== newName) {
      throw new Error(`name mismatch: got ${body.name}, want ${newName}`);
    }
  });

  // 7. Create bridge; plaintext token is returned once here.
  const bridge = await step(
    7,
    "POST /api/bridges (create)",
    async (): Promise<BridgeDTO & { token: string }> => {
      const res = await apiFetch(
        "/api/bridges",
        {
          method: "POST",
          body: JSON.stringify({ name: "smoke-bridge" }),
        },
        token,
      );
      expectStatus(res, 201);
      const body = await readJson<BridgeDTO & { token: string }>(res);
      if (!body.id || !body.token) throw new Error("missing id or token");
      return body;
    },
  );
  if (!bridge) return 1;

  // 8. Open bridge WS, send hello, wait for welcome.
  // The bridge WS handler also runs a mock: whenever the server asks for a
  // BLE scan, we reply with an empty `ble:scanResult` so step 10 can succeed.
  const bridgeWs = await step(
    8,
    "WS /ws/bridge + hello/welcome",
    async () => {
      const url = `${cli.bridgeUrl}?token=${encodeURIComponent(bridge.token)}`;
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(
          () => reject(new Error("open timeout")),
          5000,
        );
        ws.once("open", () => {
          clearTimeout(to);
          resolve();
        });
        ws.once("error", (e) => {
          clearTimeout(to);
          reject(e);
        });
      });

      // Install mock bridge behavior BEFORE sending hello so we don't miss a
      // very-early `ble:scan` (unlikely, but cheap insurance).
      ws.on("message", (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!isBridgeDown(parsed)) return;
        if (parsed.type === "ble:scan") {
          const reply: BridgeUpMsg = {
            type: "ble:scanResult",
            devices: [],
          };
          ws.send(JSON.stringify(reply));
        } else if (parsed.type === "ping") {
          const reply: BridgeUpMsg = { type: "pong" };
          ws.send(JSON.stringify(reply));
        }
      });

      const hello: BridgeUpMsg = {
        type: "hello",
        token: bridge.token,
        version: "smoke/0.1",
      };
      ws.send(JSON.stringify(hello));

      const welcome = await waitForMessage(
        ws,
        (m): m is Extract<BridgeDownMsg, { type: "welcome" }> =>
          isBridgeDown(m) && m.type === "welcome",
        5000,
        "welcome",
      );
      if (!welcome.bridgeId) throw new Error("welcome missing bridgeId");
      return ws;
    },
  );
  if (!bridgeWs) return 1;

  // 9. Bridge status in the listing. Online reflection can lag the WS
  // registration by a tick, so this is a soft assertion.
  await step(9, "GET /api/bridges (status)", async () => {
    const res = await apiFetch("/api/bridges", {}, token);
    expectStatus(res, 200);
    const list = await readJson<BridgeDTO[]>(res);
    const found = list.find((b) => b.id === bridge.id);
    if (!found) throw new Error("bridge not in list");
    if (found.status !== "online") {
      warn(`bridge status is '${found.status}', expected 'online'`);
    }
  });

  // 10. Trigger a scan (mock bridge replies with empty devices).
  await step(10, "POST /api/bridges/:id/scan", async () => {
    const res = await apiFetch(
      `/api/bridges/${bridge.id}/scan`,
      { method: "POST", body: JSON.stringify({ durationMs: 1000 }) },
      token,
    );
    expectStatus(res, 200);
    const body = await readJson<{ devices: unknown[] }>(res);
    if (!Array.isArray(body.devices)) throw new Error("no devices array");
  });

  // 11. Start a session.
  const session = await step(
    11,
    "POST /api/sessions",
    async (): Promise<SessionDTO & { tvUrl: string }> => {
      const res = await apiFetch(
        "/api/sessions",
        {
          method: "POST",
          body: JSON.stringify({ agentId: agent.id, bridgeId: bridge.id }),
        },
        token,
      );
      expectStatus(res, 201);
      const body = await readJson<SessionDTO & { tvUrl: string }>(res);
      if (!body.id || !body.tvUrl) throw new Error("missing id or tvUrl");
      return body;
    },
  );
  if (!session) return 1;

  // 12. Admin WS: subscribe and make sure the server doesn't immediately
  // reject the frame. We don't expect an echo/ack, so success = no error
  // frame within a short window.
  const adminWs = await step(
    12,
    "WS /ws/admin + subscribe",
    async () => {
      const url =
        cli.apiUrl.replace(/^http/, "ws").replace(/\/$/, "") +
        `/ws/admin?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(
          () => reject(new Error("open timeout")),
          5000,
        );
        ws.once("open", () => {
          clearTimeout(to);
          resolve();
        });
        ws.once("error", (e) => {
          clearTimeout(to);
          reject(e);
        });
      });
      ws.send(JSON.stringify({ type: "subscribe", sessionId: session.id }));

      // Listen briefly for an immediate `error` frame (bad subscribe).
      const gotError = await Promise.race<boolean>([
        new Promise<boolean>((resolve) => {
          const onMsg = (raw: WebSocket.RawData) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw.toString());
            } catch {
              return;
            }
            if (isAdminFrame(parsed) && parsed.type === "error") {
              ws.off("message", onMsg);
              resolve(true);
            }
          };
          ws.on("message", onMsg);
        }),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      if (gotError) throw new Error("admin ws returned error frame");
      return ws;
    },
  );

  // 13. TV WS: expect a `hello` with our sessionId.
  const tvWs = await step(13, "WS /ws/tv/:sessionId + hello", async () => {
    const url =
      cli.apiUrl.replace(/^http/, "ws").replace(/\/$/, "") +
      `/ws/tv/${session.id}`;
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("open timeout")), 5000);
      ws.once("open", () => {
        clearTimeout(to);
        resolve();
      });
      ws.once("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
    });
    const hello = await waitForMessage(
      ws,
      (m): m is Extract<TvDownMsg, { type: "hello" }> =>
        isTvDown(m) && m.type === "hello",
      5000,
      "tv hello",
    );
    if (hello.sessionId !== session.id) {
      throw new Error(
        `sessionId mismatch: got ${hello.sessionId}, want ${session.id}`,
      );
    }
    return ws;
  });

  // 14. End session.
  await step(14, "POST /api/sessions/:id/end", async () => {
    const res = await apiFetch(
      `/api/sessions/${session.id}/end`,
      { method: "POST" },
      token,
    );
    expectStatus(res, 200);
    const body = await readJson<SessionDTO>(res);
    if (!body.endedAt) throw new Error("endedAt not set");
  });

  // Close open sockets before cleanup (server may hold references briefly).
  try {
    adminWs?.close();
  } catch {
    /* noop */
  }
  try {
    tvWs?.close();
  } catch {
    /* noop */
  }
  try {
    bridgeWs.close();
  } catch {
    /* noop */
  }

  // 15. Cleanup.
  await step(15, "DELETE /api/agents/:id + /api/bridges/:id", async () => {
    const r1 = await apiFetch(
      `/api/agents/${agent.id}`,
      { method: "DELETE" },
      token,
    );
    expectStatus(r1, 204);
    const r2 = await apiFetch(
      `/api/bridges/${bridge.id}`,
      { method: "DELETE" },
      token,
    );
    expectStatus(r2, 204);
  });

  // ---------- Summary ----------
  const totalMs = Date.now() - t0;
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const allOk = passed === total;
  const color = allOk ? C.green : C.red;
  process.stdout.write(
    `\n${color}${passed}/${total} steps passed${C.reset}, ${totalMs}ms total\n`,
  );
  return allOk ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stdout.write(
      `${C.red}[FATAL]${C.reset} ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
