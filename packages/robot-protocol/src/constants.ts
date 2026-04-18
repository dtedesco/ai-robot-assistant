export {
  ROBERT_BLE_NAME,
  ROBERT_SERVICE_UUID,
  ROBERT_WRITE_CHAR_UUID,
  ROBERT_NOTIFY_CHAR_UUID,
} from "@robot/shared";

/** Packet header: `AA AA CC`. */
export const HEADER: readonly number[] = [0xaa, 0xaa, 0xcc];

/** Packet footer: `55 55`. */
export const FOOTER: readonly number[] = [0x55, 0x55];

/** Separator appended before the footer for action packets: `01 01`. */
export const SEPARATOR: readonly number[] = [0x01, 0x01];

/** Command byte for action packets (50 decimal). */
export const CMD_ACTION = 0x32;

/** Command byte for the bare stop packet (12 decimal). */
export const CMD_STOP = 0x0c;
