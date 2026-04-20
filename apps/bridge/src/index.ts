/**
 * Bridge daemon - BLE robot control only.
 *
 * Audio and OpenAI Realtime are now handled directly in the browser
 * (RealtimeDisplay). The bridge's only job is to receive BLE commands
 * from the API WebSocket and forward them to the robot.
 */
import { fromHex } from "@robot/protocol";
import type { BridgeDownMsg, BridgeUpMsg } from "@robot/shared";
import { BLEAutoConnect } from "./auto-connect.js";
import { BLEManager } from "./ble-manager.js";
import { BRIDGE_VERSION, loadConfig } from "./config.js";
import { startLocalHttp } from "./http.js";
import { logger, setLogLevel } from "./logger.js";
import { WSClient } from "./ws-client.js";

async function main(): Promise<void> {
  const config = loadConfig();
  setLogLevel(config.LOG_LEVEL);

  logger.info(
    `bridge starting version=${BRIDGE_VERSION} name=${config.BRIDGE_NAME}`,
  );

  const ws = new WSClient({
    url: config.API_WS_URL,
    token: config.BRIDGE_TOKEN,
  });
  const ble = new BLEManager();
  const autoConnect = new BLEAutoConnect(ble, {
    intervalMs: config.BLE_AUTO_INTERVAL_MS,
  });

  // --- BLE → WS: surface events as BridgeUpMsg ----------------------------
  ble.on("connected", (address: string) => {
    ws.send({ type: "ble:connected", address });
  });

  ble.on("disconnected", (reason?: string) => {
    ws.send({ type: "ble:disconnected", reason });
  });

  ble.on("notification", (_data: Buffer) => {
    logger.debug(`[ble] notify ${_data.toString("hex")}`);
  });

  ble.on("error", (err: Error) => {
    logger.error(`[ble] ${err.message}`);
    ws.send({ type: "ble:error", message: err.message });
  });

  // --- WS → handlers ------------------------------------------------------
  ws.on("message", async (msg: BridgeDownMsg) => {
    logger.debug(`[ws] recv ${msg.type}`);
    try {
      await handleDownMsg(msg, { ws, ble });
    } catch (err) {
      const e = err as Error;
      logger.error(`[handler] ${msg.type}: ${e.message}`);
      if (msg.type.startsWith("ble:")) {
        ws.send({ type: "ble:error", message: e.message });
      }
    }
  });

  ws.start();

  const tokenMasked =
    config.BRIDGE_TOKEN.length > 8
      ? `${config.BRIDGE_TOKEN.slice(0, 4)}…${config.BRIDGE_TOKEN.slice(-4)}`
      : "***";

  const httpApp = await startLocalHttp(
    {
      ble,
      ws,
      autoConnect,
      bridgeName: config.BRIDGE_NAME,
      tokenMasked,
      apiWsUrl: config.API_WS_URL,
    },
    config.LOCAL_HTTP_HOST,
    config.LOCAL_HTTP_PORT,
  );

  autoConnect.setEnabled(config.BLE_AUTO_CONNECT);

  // --- Graceful shutdown --------------------------------------------------
  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, shutting down`);
    try {
      autoConnect.stop();
    } catch {
      /* ignore */
    }
    try {
      await httpApp.close();
    } catch {
      /* ignore */
    }
    try {
      await ble.disconnect();
    } catch {
      /* ignore */
    }
    ws.stop();
    setTimeout(() => process.exit(0), 500);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  process.on("uncaughtException", (err) => {
    logger.error(`uncaughtException: ${err.message}\n${err.stack ?? ""}`);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error(`unhandledRejection: ${String(reason)}`);
  });
}

interface HandlerDeps {
  ws: WSClient;
  ble: BLEManager;
}

async function handleDownMsg(
  msg: BridgeDownMsg,
  deps: HandlerDeps,
): Promise<void> {
  const { ws, ble } = deps;

  switch (msg.type) {
    case "welcome": {
      logger.info(`[api] welcome bridgeId=${msg.bridgeId}`);
      // Audio/Realtime config is ignored - browser handles that now
      return;
    }

    case "ping": {
      // Auto-handled inside WSClient
      return;
    }

    case "ble:scan": {
      const devices = await ble.scan(5000);
      const reply: BridgeUpMsg = { type: "ble:scanResult", devices };
      ws.send(reply);
      return;
    }

    case "ble:connect": {
      try {
        await ble.connect(msg.address);
      } catch (err) {
        const e = err as Error;
        logger.error(`[ble] connect ${msg.address} failed: ${e.message}`);
        ws.send({ type: "ble:error", message: e.message });
      }
      return;
    }

    case "ble:disconnect": {
      await ble.disconnect();
      return;
    }

    case "ble:packet": {
      if (!ble.isConnected()) {
        ws.send({ type: "ble:error", message: "not connected" });
        return;
      }
      const bytes = fromHex(msg.hex);
      await ble.write(bytes);
      logger.debug(`[ble] wrote ${bytes.length} bytes`);
      return;
    }

    // Legacy session messages - no longer handled by bridge
    case "session:start":
    case "session:end":
    case "audio:out":
    case "greeting:trigger": {
      logger.warn(`[ws] legacy message type ignored: ${msg.type}`);
      return;
    }

    default: {
      const _never: never = msg;
      logger.warn(`[ws] unknown message type: ${JSON.stringify(_never)}`);
      return;
    }
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("fatal:", err);
  process.exit(1);
});
