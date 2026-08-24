/**
 * Guards the daily-energy rollup against the DTU's late counter reset.
 *
 * The gateway's daily counter resets some minutes *after* local midnight, not exactly at
 * it. Until it does, readings stamped with the new local date still carry yesterday's
 * cumulative total. Because the rollup is MAX(dailyEnergy) GROUP BY localDate, a single
 * such row silently reports yesterday's energy as today's whenever today ends up smaller —
 * a bright day followed by an overcast one. (Observed live: 2026-07-24 opened with four
 * rows holding 39,985 Wh, which was 2026-07-23's final total.)
 *
 * Strategy: once we cross a local-date boundary without the counter dropping, report 0
 * until we actually observe the reset. Nothing is lost — the previous day's true maximum
 * was already recorded before midnight. Assumes no production at local midnight, which
 * holds at this latitude.
 */
export class DailyCounterTracker {
  private lastRawWh = 0;
  private lastLocalDate: string | null = null;
  private awaitingReset = false;

  /** Restore state from the newest stored reading so restarts don't reopen the hole. */
  seed(localDate: string, lastStoredWh: number): void {
    this.lastLocalDate = localDate;
    this.lastRawWh = lastStoredWh;
  }

  /** True while we believe the counter still holds the previous day's total. */
  get carryingOver(): boolean {
    return this.awaitingReset;
  }

  /** Map a raw counter reading to the value that should be stored for `localDate`. */
  resolve(localDate: string, rawWh: number): number {
    if (this.lastLocalDate !== null && localDate !== this.lastLocalDate) {
      // New local day: if the counter hasn't dropped, it is still yesterday's total.
      this.awaitingReset = this.lastRawWh > 0 && rawWh >= this.lastRawWh;
    } else if (this.awaitingReset && rawWh < this.lastRawWh) {
      this.awaitingReset = false; // reset observed — trust the counter again
    }

    const resolved = this.awaitingReset ? 0 : rawWh;
    this.lastRawWh = rawWh;
    this.lastLocalDate = localDate;
    return resolved;
  }
}
