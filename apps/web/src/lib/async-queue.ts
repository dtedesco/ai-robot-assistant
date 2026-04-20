/**
 * Async Queue - Fire-and-forget API calls with retry.
 *
 * Ensures API calls don't block the UI while maintaining order
 * and providing retry logic for failed requests.
 */

interface QueueItem {
  id: string;
  fn: () => Promise<void>;
  retries: number;
  maxRetries: number;
}

class AsyncQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private maxConcurrent = 3;
  private activeCount = 0;

  /**
   * Add a task to the queue (fire-and-forget).
   */
  enqueue(fn: () => Promise<void>, maxRetries = 2): void {
    const id = crypto.randomUUID();
    this.queue.push({ id, fn, retries: 0, maxRetries });
    this.processQueue();
  }

  private async processQueue(): Promise<void> {
    if (this.activeCount >= this.maxConcurrent) return;

    const item = this.queue.shift();
    if (!item) return;

    this.activeCount++;

    try {
      await item.fn();
    } catch (err) {
      if (item.retries < item.maxRetries) {
        // Re-queue with incremented retry count
        item.retries++;
        this.queue.push(item);
        console.warn(`[queue] retry ${item.retries}/${item.maxRetries}`, err);
      } else {
        console.error("[queue] max retries exceeded", err);
      }
    } finally {
      this.activeCount--;
      // Process next item
      if (this.queue.length > 0) {
        this.processQueue();
      }
    }
  }

  /**
   * Clear the queue (e.g., on unmount).
   */
  clear(): void {
    this.queue = [];
  }

  get pendingCount(): number {
    return this.queue.length + this.activeCount;
  }
}

// Singleton instance for the app
export const apiQueue = new AsyncQueue();

/**
 * Debounced function wrapper.
 */
export function debounce<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delay: number,
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Throttled function wrapper - ensures function runs at most once per interval.
 */
export function throttle<T extends (...args: Parameters<T>) => void>(
  fn: T,
  interval: number,
): (...args: Parameters<T>) => void {
  let lastRun = 0;
  let pendingArgs: Parameters<T> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return (...args: Parameters<T>) => {
    const now = Date.now();
    const elapsed = now - lastRun;

    if (elapsed >= interval) {
      lastRun = now;
      fn(...args);
    } else {
      // Schedule for later
      pendingArgs = args;
      if (!timeoutId) {
        timeoutId = setTimeout(() => {
          if (pendingArgs) {
            lastRun = Date.now();
            fn(...pendingArgs);
            pendingArgs = null;
          }
          timeoutId = null;
        }, interval - elapsed);
      }
    }
  };
}
