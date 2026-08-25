/**
 * The DTU's daily counter resets some minutes *after* local midnight, so readings stamped
 * with the new local date still carry yesterday's cumulative total; the rollup being
 * MAX(dailyEnergy) GROUP BY localDate, one such row reports it as today's. (Observed
 * 2026-07-24: four rows at 39,985 Wh, 2026-07-23's final total.)
 *
 * So once a local-date boundary is crossed without the counter dropping, report 0 until the
 * reset is seen. Assumes no production at local midnight, which holds at this latitude.
 */
export class DailyCounterTracker {
  private lastRawWh = 0;
  private lastLocalDate: string | null = null;
  private awaitingReset = false;

  /** Restore from the newest stored reading, so a restart does not reopen the gap. */
  seed(localDate: string, lastStoredWh: number): void {
    this.lastLocalDate = localDate;
    this.lastRawWh = lastStoredWh;
  }

  get carryingOver(): boolean {
    return this.awaitingReset;
  }

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
