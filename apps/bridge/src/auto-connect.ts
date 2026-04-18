/**
 * Auto-reconnect loop for the Robert BLE peripheral.
 *
 * When enabled, continuously watches the BLE state: if the bridge isn't
 * connected and nothing else is scanning, it runs a short scan, picks the
 * first Robert that shows up and tries to connect. On failure or disconnect
 * it backs off and retries. The user can pause/resume at runtime via the
 * local HTTP UI.
 */
import type { BLEManager } from "./ble-manager.js";
import { logger } from "./logger.js";

export interface AutoConnectStatus {
  enabled: boolean;
  running: boolean;
  lastAttemptAt: string | null;
  lastError: string | null;
  lastConnectedAt: string | null;
}

export interface AutoConnectOptions {
  /** Gap between reconnect cycles when disconnected. */
  intervalMs?: number;
  /** How long each scan lasts per cycle. Short = adapter is free faster. */
  scanDurationMs?: number;
}

export class BLEAutoConnect {
  private enabled = false;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly scanDurationMs: number;
  private lastAttemptAt: Date | null = null;
  private lastError: string | null = null;
  private lastConnectedAt: Date | null = null;
  private inCycle = false;

  constructor(
    private readonly ble: BLEManager,
    opts: AutoConnectOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 10_000;
    this.scanDurationMs = opts.scanDurationMs ?? 3_000;

    this.ble.on("connected", () => {
      this.lastConnectedAt = new Date();
      this.lastError = null;
    });
    this.ble.on("disconnected", () => {
      // Drop-through: the next tick will attempt to reconnect if enabled.
    });
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      logger.info("[auto] enabled — will scan for Robert");
      this.scheduleNext(0);
    } else {
      logger.info("[auto] disabled");
      this.clearTimer();
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  status(): AutoConnectStatus {
    return {
      enabled: this.enabled,
      running: this.inCycle,
      lastAttemptAt: this.lastAttemptAt?.toISOString() ?? null,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt?.toISOString() ?? null,
    };
  }

  stop(): void {
    this.setEnabled(false);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.clearTimer();
    if (!this.enabled) return;
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    if (!this.enabled) return;
    if (this.ble.isConnected()) {
      // Already connected — nothing to do, just poll again later.
      this.scheduleNext(this.intervalMs);
      return;
    }
    if (this.inCycle) {
      this.scheduleNext(this.intervalMs);
      return;
    }

    this.inCycle = true;
    this.lastAttemptAt = new Date();
    this.running = true;

    try {
      const devices = await this.ble.scan(this.scanDurationMs);
      if (!this.enabled) return;
      if (devices.length === 0) {
        logger.debug("[auto] no Robert found this cycle");
      } else {
        const target = devices[0]!;
        logger.info(`[auto] attempting ${target.name ?? "?"} ${target.address}`);
        await this.ble.connect(target.address);
        // `connected` event updates lastConnectedAt.
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      logger.warn(`[auto] cycle failed: ${msg}`);
    } finally {
      this.inCycle = false;
      this.running = false;
      this.scheduleNext(this.intervalMs);
    }
  }
}
