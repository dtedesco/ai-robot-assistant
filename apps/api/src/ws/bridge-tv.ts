import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { TvDownMsg, TvUpMsg } from "@robot/shared";
import type { TvHub } from "../services/tv-hub.js";
import type { SessionHub } from "../services/session-hub.js";
import { findClosestMatch } from "../services/face-matching.js";
import { prisma } from "../db.js";

function send(socket: WebSocket, msg: TvDownMsg): void {
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* noop */
  }
}

function parseMsg(raw: string): TvUpMsg | null {
  try {
    return JSON.parse(raw) as TvUpMsg;
  } catch {
    return null;
  }
}

/** Store pending face descriptors by bridgeId for registration flow */
const pendingDescriptors = new Map<string, number[]>();

/** Track last identified person to avoid repeated greetings */
const lastIdentified = new Map<string, { personId: string | null; timestamp: number }>();

/** Cooldown between greetings for the same person (ms) */
const GREETING_COOLDOWN_MS = 30_000;

/**
 * Public TV socket keyed by bridgeId. Now bidirectional:
 * - Outgoing: TV display messages (display, clear, face events)
 * - Incoming: Face detection events from browser camera
 */
export function registerBridgeTvWs(
  app: FastifyInstance,
  tvHub: TvHub,
  sessionHub: SessionHub,
): void {
  app.get(
    "/ws/tv/bridge/:bridgeId",
    { websocket: true },
    (socket, req) => {
      const { bridgeId } = req.params as { bridgeId: string };
      const log = req.log.child({ bridgeId, ws: "bridge-tv" });

      send(socket, { type: "hello", sessionId: bridgeId });

      // Subscribe to outgoing TV messages
      const unsub = tvHub.subscribe(bridgeId, (msg) => send(socket, msg));

      // Handle incoming messages from TV (face detection)
      socket.on("message", async (raw) => {
        const msg = parseMsg(raw.toString());
        if (!msg) return;

        switch (msg.type) {
          case "face:detected": {
            const { descriptor } = msg;
            if (!Array.isArray(descriptor) || descriptor.length !== 128) {
              log.warn("Invalid face descriptor received");
              return;
            }

            // Store descriptor for potential registration
            pendingDescriptors.set(bridgeId, descriptor);

            // Try to match against known persons
            const match = await findClosestMatch(descriptor, 0.6);

            if (match) {
              log.info({ personId: match.person.id, name: match.person.name, distance: match.distance }, "Face matched");
              send(socket, {
                type: "face:identified",
                personId: match.person.id,
                name: match.person.name,
              });
            } else {
              log.info("Unknown face detected");
              send(socket, {
                type: "face:unknown",
                tempId: bridgeId,
              });
            }
            break;
          }

          case "face:idle": {
            // Face has been stable - trigger greeting
            const descriptor = pendingDescriptors.get(bridgeId);
            const match = descriptor
              ? await findClosestMatch(descriptor, 0.6)
              : null;

            const personId = match?.person.id ?? null;
            const personName = match?.person.name ?? null;

            // Check cooldown to avoid repeated greetings
            const last = lastIdentified.get(bridgeId);
            const now = Date.now();

            if (
              last &&
              last.personId === personId &&
              now - last.timestamp < GREETING_COOLDOWN_MS
            ) {
              log.debug("Skipping greeting - cooldown active");
              return;
            }

            // Update last identified
            lastIdentified.set(bridgeId, { personId, timestamp: now });

            log.info({ personId, personName }, "Triggering greeting");

            // Send greeting trigger to bridge
            sessionHub.sendToBridge(bridgeId, {
              type: "greeting:trigger",
              personName,
              personId,
            });
            break;
          }

          case "face:lost": {
            // Face left the frame - clear pending descriptor
            pendingDescriptors.delete(bridgeId);
            break;
          }
        }
      });

      socket.on("close", () => {
        unsub();
        pendingDescriptors.delete(bridgeId);
      });
    },
  );
}

/**
 * Register a new person with a pending face descriptor.
 * Called from the bridge when the user provides their name.
 */
export async function registerPendingPerson(
  bridgeId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const descriptor = pendingDescriptors.get(bridgeId);
  if (!descriptor) return null;

  const person = await prisma.person.create({
    data: {
      name,
      faceDescriptor: descriptor as unknown as object,
    },
  });

  // Clear pending descriptor after successful registration
  pendingDescriptors.delete(bridgeId);

  return { id: person.id, name: person.name };
}
