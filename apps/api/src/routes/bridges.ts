import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { BLEDevice, BridgeDTO, BridgeUpMsg } from "@robot/shared";
import { prisma } from "../db.js";
import type { SessionHub } from "../services/session-hub.js";

const CreateBridgeSchema = z.object({
  name: z.string().min(1),
});

const ScanSchema = z.object({
  durationMs: z.number().int().positive().max(30_000).optional(),
});

const ConnectBleSchema = z.object({
  address: z.string().min(1),
});

interface BridgeRow {
  id: string;
  name: string;
  token: string;
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
}

function serializeBridge(row: BridgeRow): BridgeDTO {
  return {
    id: row.id,
    name: row.name,
    status: row.status === "online" ? "online" : "offline",
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** Default scan duration when caller doesn't specify one. */
const DEFAULT_SCAN_TIMEOUT_MS = 10_000;
/** Buffer added on top of scan duration to allow for network round-trip. */
const SCAN_NETWORK_BUFFER_MS = 2_000;
/** Connect-BLE total timeout. */
const CONNECT_TIMEOUT_MS = 15_000;

export function bridgeRoutes(hub: SessionHub): FastifyPluginAsync {
  return async (app: FastifyInstance) => {
    app.addHook("onRequest", app.authenticate);

    app.get("/bridges", async () => {
      const rows = await prisma.bridge.findMany({
        orderBy: { createdAt: "desc" },
      });
      return rows.map((r: BridgeRow) => serializeBridge(r));
    });

    /**
     * Creates a bridge and returns the plaintext token ONCE. The token is
     * stored as-is (bridge uses it to authenticate the WS); rotate by deleting
     * and creating a new bridge.
     */
    app.post("/bridges", async (req, reply) => {
      const input = CreateBridgeSchema.parse(req.body);
      const token = generateToken();
      const row = await prisma.bridge.create({
        data: { name: input.name, token, status: "offline" },
      });
      return reply.status(201).send({
        ...serializeBridge(row),
        token,
      });
    });

    app.delete<{ Params: { id: string } }>(
      "/bridges/:id",
      async (req, reply) => {
        try {
          await prisma.bridge.delete({ where: { id: req.params.id } });
          return reply.status(204).send();
        } catch {
          return reply.status(404).send({ error: "NotFound" });
        }
      },
    );

    /**
     * Trigger a BLE scan on the given bridge and wait for the result.
     *
     * Asks the bridge to start scanning and returns the discovered devices
     * once it replies with `ble:scanResult`. Times out after `durationMs +
     * network buffer`.
     */
    app.post<{ Params: { id: string }; Body: unknown }>(
      "/bridges/:id/scan",
      async (req, reply) => {
        const bridge = await prisma.bridge.findUnique({
          where: { id: req.params.id },
        });
        if (!bridge) {
          return reply.status(404).send({ error: "BridgeNotFound" });
        }
        if (!hub.isBridgeOnline(bridge.id)) {
          return reply.status(409).send({ error: "BridgeOffline" });
        }
        const body = ScanSchema.parse(req.body ?? {});
        const durationMs = body.durationMs ?? DEFAULT_SCAN_TIMEOUT_MS;
        const timeoutMs = durationMs + SCAN_NETWORK_BUFFER_MS;
        try {
          const result = await hub.requestFromBridge(
            bridge.id,
            { type: "ble:scan" },
            (msg: BridgeUpMsg) =>
              msg.type === "ble:scanResult" || msg.type === "ble:error",
            timeoutMs,
          );
          if (result.type === "ble:error") {
            return reply
              .status(502)
              .send({ error: "BridgeError", message: result.message });
          }
          if (result.type !== "ble:scanResult") {
            return reply
              .status(502)
              .send({ error: "BridgeError", message: "unexpected reply" });
          }
          const devices: BLEDevice[] = result.devices;
          return { devices };
        } catch (err) {
          return reply
            .status(504)
            .send({ error: "ScanFailed", message: String(err) });
        }
      },
    );

    /**
     * Ask the bridge to connect to a specific BLE peripheral by address.
     */
    app.post<{ Params: { id: string }; Body: unknown }>(
      "/bridges/:id/connect-ble",
      async (req, reply) => {
        const bridge = await prisma.bridge.findUnique({
          where: { id: req.params.id },
        });
        if (!bridge) {
          return reply.status(404).send({ error: "BridgeNotFound" });
        }
        if (!hub.isBridgeOnline(bridge.id)) {
          return reply.status(409).send({ error: "BridgeOffline" });
        }
        const body = ConnectBleSchema.parse(req.body ?? {});
        try {
          const result = await hub.requestFromBridge(
            bridge.id,
            { type: "ble:connect", address: body.address },
            (msg: BridgeUpMsg) =>
              (msg.type === "ble:connected" && msg.address === body.address) ||
              msg.type === "ble:error" ||
              msg.type === "ble:disconnected",
            CONNECT_TIMEOUT_MS,
          );
          if (result.type === "ble:connected") {
            return { ok: true as const };
          }
          if (result.type === "ble:error") {
            return reply
              .status(502)
              .send({ error: "BridgeError", message: result.message });
          }
          if (result.type === "ble:disconnected") {
            return reply.status(502).send({
              error: "BridgeError",
              message: result.reason ?? "disconnected",
            });
          }
          return reply
            .status(502)
            .send({ error: "BridgeError", message: "unexpected reply" });
        } catch (err) {
          return reply
            .status(504)
            .send({ error: "ConnectFailed", message: String(err) });
        }
      },
    );
  };
}
