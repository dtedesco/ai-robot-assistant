import { EventEmitter } from "node:events";
import {
  ROBERT_NOTIFY_CHAR_UUID,
  ROBERT_SERVICE_UUID,
  ROBERT_WRITE_CHAR_UUID,
  type BLEDevice,
} from "@robot/shared";
import { logger } from "./logger.js";

/**
 * Strip dashes from a UUID and lowercase it. Noble compares UUIDs in the short
 * 16-bit or 128-bit *no-dash* form, so we normalize once.
 */
function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

const NORM_SERVICE_UUID = normalizeUuid(ROBERT_SERVICE_UUID);
const NORM_WRITE_CHAR_UUID = normalizeUuid(ROBERT_WRITE_CHAR_UUID);
const NORM_NOTIFY_CHAR_UUID = normalizeUuid(ROBERT_NOTIFY_CHAR_UUID);

/** SIG base UUID (no dashes, lowercase) — characters AFTER the 16-bit slot
 *  in 0000XXXX-0000-1000-8000-00805F9B34FB. 24 hex chars. */
const SIG_BASE_TAIL = "00001000800000805f9b34fb";

/** Extract the 16-bit short UUID ("ffc1") from a 32-char SIG-base long UUID,
 *  or null if the long form is not a SIG-base UUID. */
function toShortUuid(normalized: string): string | null {
  if (normalized.length !== 32) return null;
  if (!normalized.startsWith("0000")) return null;
  if (!normalized.endsWith(SIG_BASE_TAIL)) return null;
  return normalized.slice(4, 8);
}

/**
 * Compare two UUIDs accepting both 128-bit long form and 16-bit short form.
 * Noble on macOS (Core Bluetooth) reports SIG-base characteristics as the
 * 4-char short form ("ffc1"), while our constants live in 128-bit long form.
 * Strict === breaks that match.
 */
function uuidsMatch(a: string, b: string): boolean {
  const na = normalizeUuid(a);
  const nb = normalizeUuid(b);
  if (na === nb) return true;
  const sa = na.length === 4 ? na : toShortUuid(na);
  const sb = nb.length === 4 ? nb : toShortUuid(nb);
  return sa !== null && sb !== null && sa === sb;
}

// TODO(ble): @abandonware/noble loads native bindings at import time. On macOS
// it occasionally surfaces "No compatible USB Bluetooth 4.0 device found" until
// the HCI (or CoreBluetooth) bindings are reset. If you hit that, try:
//   import noble from "@abandonware/noble";
//   noble.reset();
// On Linux, ensure the process has CAP_NET_RAW/CAP_NET_ADMIN or runs as root.

// Noble lacks first-party types. We model the surface we need.
interface NobleCharacteristic {
  uuid: string;
  properties: string[];
  write(data: Buffer, withoutResponse: boolean, cb?: (err?: Error) => void): void;
  subscribe(cb?: (err?: Error) => void): void;
  unsubscribe(cb?: (err?: Error) => void): void;
  on(event: "data", listener: (data: Buffer, isNotification: boolean) => void): void;
  removeAllListeners(event?: string): void;
}

interface NobleService {
  uuid: string;
  discoverCharacteristics(
    uuids: string[],
    cb: (err: Error | null, chars: NobleCharacteristic[]) => void,
  ): void;
}

interface NoblePeripheral {
  id: string;
  uuid: string;
  address: string;
  addressType: string;
  advertisement: {
    localName?: string;
    serviceUuids?: string[];
  };
  rssi: number;
  state: string;
  connect(cb: (err?: Error | null) => void): void;
  disconnect(cb?: (err?: Error | null) => void): void;
  discoverSomeServicesAndCharacteristics(
    serviceUuids: string[],
    characteristicUuids: string[],
    cb: (
      err: Error | null,
      services: NobleService[],
      characteristics: NobleCharacteristic[],
    ) => void,
  ): void;
  once(event: "disconnect", listener: () => void): void;
  removeAllListeners(event?: string): void;
}

interface NobleModule {
  state: string;
  on(event: "stateChange", listener: (state: string) => void): void;
  on(event: "scanStart", listener: () => void): void;
  on(event: "scanStop", listener: () => void): void;
  on(event: "discover", listener: (p: NoblePeripheral) => void): void;
  removeListener(event: string, listener: (...args: never[]) => void): void;
  startScanning(
    serviceUuids: string[],
    allowDuplicates: boolean,
    cb?: (err?: Error) => void,
  ): void;
  stopScanning(cb?: () => void): void;
  reset?(): void;
}

export type BLEManagerEvents = {
  connected: [address: string];
  disconnected: [reason?: string];
  notification: [data: Buffer];
  error: [err: Error];
};

export class BLEManager extends EventEmitter {
  private noble: NobleModule | null = null;
  private peripheral: NoblePeripheral | null = null;
  private writeChar: NobleCharacteristic | null = null;
  private notifyChar: NobleCharacteristic | null = null;
  private scanning = false;

  /** Lazy-load noble so import-time failures (missing bluez/libudev) are
   *  surface-able to callers rather than crashing the whole process. */
  private async loadNoble(): Promise<NobleModule> {
    if (this.noble) return this.noble;
    try {
      // Dynamic import keeps the native addon cost off the cold path.
      const mod = (await import("@abandonware/noble")) as unknown as {
        default?: NobleModule;
      } & NobleModule;
      const noble = (mod.default ?? mod) as NobleModule;
      this.noble = noble;
      return noble;
    } catch (err) {
      const e = err as Error;
      throw new Error(
        `Failed to load @abandonware/noble: ${e.message}. ` +
          `On Linux install bluez + libbluetooth-dev + libudev-dev. ` +
          `On macOS grant Bluetooth permission to the terminal/Node binary.`,
      );
    }
  }

  private async waitPoweredOn(timeoutMs = 10_000): Promise<void> {
    const noble = await this.loadNoble();
    if (noble.state === "poweredOn") return;
    await new Promise<void>((resolve, reject) => {
      const onState = (state: string): void => {
        if (state === "poweredOn") {
          clearTimeout(timer);
          noble.removeListener("stateChange", onState);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        noble.removeListener("stateChange", onState);
        reject(new Error(`BLE adapter not poweredOn (state=${noble.state})`));
      }, timeoutMs);
      noble.on("stateChange", onState);
    });
  }

  /**
   * Scans for nearby BLE devices advertising Robert's service UUID.
   * Returns unique devices indexed by address.
   */
  async scan(durationMs = 5000): Promise<BLEDevice[]> {
    const noble = await this.loadNoble();
    await this.waitPoweredOn();

    if (this.scanning) {
      throw new Error("scan already in progress");
    }

    const found = new Map<string, BLEDevice>();

    return new Promise<BLEDevice[]>((resolve, reject) => {
      const onDiscover = (p: NoblePeripheral): void => {
        // Some peripherals don't advertise their primary service UUID in ADV
        // data — match by name when the UUID filter misses.
        const adv = p.advertisement ?? {};
        const advUuids = (adv.serviceUuids ?? []).map((u) =>
          u.replace(/-/g, "").toLowerCase(),
        );
        const name = adv.localName ?? null;
        const isRobert =
          advUuids.includes(NORM_SERVICE_UUID) ||
          (name != null && /robert/i.test(name));
        if (!isRobert) return;

        const address = this.peripheralAddress(p);
        if (!found.has(address)) {
          found.set(address, { address, name, rssi: p.rssi });
          logger.info(
            `[ble] discovered ${name ?? "?"} ${address} rssi=${p.rssi}`,
          );
        }
      };

      noble.on("discover", onDiscover);
      this.scanning = true;

      noble.startScanning([NORM_SERVICE_UUID], false, (err) => {
        if (err) {
          this.scanning = false;
          noble.removeListener("discover", onDiscover);
          reject(
            new Error(`startScanning failed: ${err.message}. ` +
              `Falling back to unfiltered scan may require adapter restart.`),
          );
          return;
        }

        setTimeout(() => {
          noble.stopScanning(() => {
            this.scanning = false;
            noble.removeListener("discover", onDiscover);
            resolve(Array.from(found.values()));
          });
        }, durationMs);
      });
    });
  }

  /** Connect by advertised address (noble's `peripheral.address` or its id on macOS). */
  async connect(address: string): Promise<void> {
    const noble = await this.loadNoble();
    await this.waitPoweredOn();

    if (this.peripheral) {
      throw new Error("already connected; call disconnect() first");
    }

    // Find the peripheral by doing a short scan if we don't already have it.
    const peripheral = await this.findPeripheral(noble, address, 10_000);
    if (!peripheral) {
      throw new Error(`peripheral ${address} not found`);
    }

    await new Promise<void>((resolve, reject) => {
      peripheral.connect((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    logger.info(`[ble] connected to ${this.peripheralAddress(peripheral)}`);

    // Discover everything on the peripheral and match manually. Passing
    // filter arrays to noble is unreliable on macOS — the native layer
    // reports SIG-base UUIDs in short form which causes empty results.
    const { writeChar, notifyChar } = await new Promise<{
      writeChar: NobleCharacteristic;
      notifyChar: NobleCharacteristic;
    }>((resolve, reject) => {
      peripheral.discoverSomeServicesAndCharacteristics(
        [],
        [],
        (err, _services, chars) => {
          if (err) {
            reject(err);
            return;
          }
          logger.debug(
            `[ble] discovered chars: ${chars.map((c) => c.uuid).join(",")}`,
          );
          const write = chars.find((c) => uuidsMatch(c.uuid, NORM_WRITE_CHAR_UUID));
          const notify = chars.find((c) => uuidsMatch(c.uuid, NORM_NOTIFY_CHAR_UUID));
          if (!write) {
            reject(
              new Error(
                `write characteristic FFC1 not found (saw: ${chars.map((c) => c.uuid).join(",") || "none"})`,
              ),
            );
            return;
          }
          if (!notify) {
            reject(
              new Error(
                `notify characteristic FFC2 not found (saw: ${chars.map((c) => c.uuid).join(",") || "none"})`,
              ),
            );
            return;
          }
          resolve({ writeChar: write, notifyChar: notify });
        },
      );
    });

    // Subscribe to notifications.
    await new Promise<void>((resolve, reject) => {
      notifyChar.subscribe((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    notifyChar.on("data", (data) => {
      // Skip trivial all-zero heartbeat frames.
      if (data.every((b) => b === 0)) return;
      this.emit("notification", data);
    });

    peripheral.once("disconnect", () => {
      logger.warn("[ble] peripheral disconnected");
      this.peripheral = null;
      this.writeChar = null;
      this.notifyChar = null;
      this.emit("disconnected", "peripheral disconnect");
    });

    this.peripheral = peripheral;
    this.writeChar = writeChar;
    this.notifyChar = notifyChar;
    this.emit("connected", this.peripheralAddress(peripheral));
  }

  async disconnect(): Promise<void> {
    const p = this.peripheral;
    if (!p) return;
    try {
      if (this.notifyChar) {
        await new Promise<void>((resolve) => {
          this.notifyChar!.unsubscribe(() => resolve());
        });
      }
    } catch {
      /* best-effort */
    }
    await new Promise<void>((resolve) => {
      p.disconnect(() => resolve());
    });
    this.peripheral = null;
    this.writeChar = null;
    this.notifyChar = null;
  }

  /** Write a raw packet to Robert using write-without-response (fast path). */
  async write(packet: Uint8Array): Promise<void> {
    const ch = this.writeChar;
    if (!ch) throw new Error("not connected");
    const buf = Buffer.from(packet.buffer, packet.byteOffset, packet.byteLength);
    await new Promise<void>((resolve, reject) => {
      ch.write(buf, true, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  isConnected(): boolean {
    return this.peripheral != null && this.writeChar != null;
  }

  private peripheralAddress(p: NoblePeripheral): string {
    // macOS gives synthetic UUIDs via p.id; Linux gives MAC via p.address.
    if (p.address && p.address !== "" && p.address !== "unknown") {
      return p.address;
    }
    return p.id ?? p.uuid;
  }

  private async findPeripheral(
    noble: NobleModule,
    address: string,
    timeoutMs: number,
  ): Promise<NoblePeripheral | null> {
    if (this.scanning) {
      // Wait briefly for the existing scan to finish.
      await new Promise((r) => setTimeout(r, 250));
    }

    const target = address.toLowerCase();

    return new Promise<NoblePeripheral | null>((resolve) => {
      let settled = false;
      const onDiscover = (p: NoblePeripheral): void => {
        const candidate = this.peripheralAddress(p).toLowerCase();
        if (candidate === target) {
          settled = true;
          noble.removeListener("discover", onDiscover);
          noble.stopScanning(() => {
            this.scanning = false;
            resolve(p);
          });
        }
      };
      noble.on("discover", onDiscover);
      this.scanning = true;
      noble.startScanning([NORM_SERVICE_UUID], false, (err) => {
        if (err) {
          this.scanning = false;
          noble.removeListener("discover", onDiscover);
          resolve(null);
          return;
        }
      });
      setTimeout(() => {
        if (!settled) {
          noble.removeListener("discover", onDiscover);
          noble.stopScanning(() => {
            this.scanning = false;
            resolve(null);
          });
        }
      }, timeoutMs);
    });
  }
}
