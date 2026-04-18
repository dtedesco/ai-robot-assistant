import {
  CMD_ACTION,
  CMD_STOP,
  FOOTER,
  HEADER,
  SEPARATOR,
} from "./constants.js";
import {
  ACTION_STOP,
  COLORS,
  MOVE,
  type MoveDirection,
  isValidAction,
  isValidColor,
} from "./actions.js";

export interface ActionPacketOptions {
  /** Action code (1-93, 100-110, 200-235, or 77). */
  action: number;
  /** Speed byte: defaults to 8 for ordinary actions, 0xFF for directional moves (1-4). */
  speedByte?: number;
  /** Speed level, 0-3. Default 0. */
  speedLevel?: number;
  /** LED color, 1-7. Default 2 (blue). */
  color?: number;
  /** 0 = eyes on, 4 = eyes off. Default 0. */
  colorMode?: number;
}

const MOVE_CODES: ReadonlySet<number> = new Set<number>([
  MOVE.down,
  MOVE.up,
  MOVE.left,
  MOVE.right,
]);

function assertByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(
      `${name} must be an integer in [0, 255], got ${String(value)}`,
    );
  }
}

/**
 * Builds a 17-byte action packet.
 *
 * Layout:
 *   [HEADER(3), CMD_ACTION, 0x01, action, action, speedByte, speedLevel,
 *    color, colorMode, 0x02, 0x02, SEPARATOR(2), FOOTER(2)]
 */
export function buildActionPacket(opts: ActionPacketOptions): Uint8Array {
  const { action } = opts;

  if (!isValidAction(action)) {
    throw new Error(
      `Invalid action code ${String(action)}: expected 1-93, 100-110, 200-235, or 77.`,
    );
  }

  const speedByte =
    opts.speedByte ?? (MOVE_CODES.has(action) ? 0xff : 8);
  const speedLevel = opts.speedLevel ?? 0;
  const color = opts.color ?? COLORS.BLUE;
  const colorMode = opts.colorMode ?? 0;

  if (!isValidColor(color)) {
    throw new Error(
      `Invalid color ${String(color)}: expected integer 1-7.`,
    );
  }
  assertByte("speedByte", speedByte);
  if (!Number.isInteger(speedLevel) || speedLevel < 0 || speedLevel > 3) {
    throw new Error(
      `Invalid speedLevel ${String(speedLevel)}: expected integer 0-3.`,
    );
  }
  if (colorMode !== 0 && colorMode !== 4) {
    throw new Error(
      `Invalid colorMode ${String(colorMode)}: expected 0 (on) or 4 (off).`,
    );
  }

  const packet = new Uint8Array(17);
  let i = 0;
  packet[i++] = HEADER[0]!;
  packet[i++] = HEADER[1]!;
  packet[i++] = HEADER[2]!;
  packet[i++] = CMD_ACTION;
  packet[i++] = 0x01;
  packet[i++] = action;
  packet[i++] = action;
  packet[i++] = speedByte;
  packet[i++] = speedLevel;
  packet[i++] = color;
  packet[i++] = colorMode;
  packet[i++] = 0x02;
  packet[i++] = 0x02;
  packet[i++] = SEPARATOR[0]!;
  packet[i++] = SEPARATOR[1]!;
  packet[i++] = FOOTER[0]!;
  packet[i++] = FOOTER[1]!;
  return packet;
}

/** Builds the 6-byte stop packet: `AA AA CC 0C 55 55`. */
export function buildStopPacket(): Uint8Array {
  return new Uint8Array([
    HEADER[0]!,
    HEADER[1]!,
    HEADER[2]!,
    CMD_STOP,
    FOOTER[0]!,
    FOOTER[1]!,
  ]);
}

/**
 * Builds a directional move packet. Uses action codes 1-4 with speedByte 0xFF.
 */
export function buildMovePacket(
  dir: MoveDirection,
  speedLevel = 0,
  color: number = COLORS.BLUE,
): Uint8Array {
  const action = MOVE[dir];
  return buildActionPacket({
    action,
    speedByte: 0xff,
    speedLevel,
    color,
  });
}

/**
 * Builds a color-change packet (action 77 with the requested color).
 */
export function buildColorPacket(color: number): Uint8Array {
  if (!isValidColor(color)) {
    throw new Error(
      `Invalid color ${String(color)}: expected integer 1-7.`,
    );
  }
  return buildActionPacket({ action: ACTION_STOP, color });
}
