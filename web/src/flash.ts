import type { Clock } from "./save-lifecycle";

export interface Flasher {
  /** Show `value` on the badge named `key` and clear it after the window. */
  show: <T>(key: string, set: (v: T | null) => void, value: T) => void;
  /** Drop every pending timer without firing it — for unmount. */
  cancelAll: () => void;
}

/**
 * Timers for the transient "Copied ✓" / "Opened ✓" badges, one per badge.
 *
 * Keyed rather than single: a single shared timer means pressing the second
 * button inside the window clears the FIRST badge's timer and replaces it with
 * one that only resets the second setter — so the first badge stays lit for the
 * rest of the card's life. Keyed rather than per-call: two presses of the SAME
 * button must replace each other, or the earlier timer cuts the later badge short.
 */
export function createFlasher(
  ms: number,
  clock: Clock = { set: setTimeout, clear: clearTimeout },
): Flasher {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    show<T>(key: string, set: (v: T | null) => void, value: T): void {
      set(value);
      const running = timers.get(key);
      if (running !== undefined) clock.clear(running);
      timers.set(
        key,
        clock.set(() => {
          timers.delete(key);
          set(null);
        }, ms),
      );
    },
    cancelAll(): void {
      for (const t of timers.values()) clock.clear(t);
      timers.clear();
    },
  };
}
