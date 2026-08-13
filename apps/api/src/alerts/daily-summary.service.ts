import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CollectorService } from '../collector/collector.service';
import { ReadingsService } from '../readings/readings.service';
import { ChargerService } from '../charger/charger.service';
import { localDateOf } from '../common/localdate';
import { AlertsService } from './alerts.service';
import { NotifierService } from './notifier.service';

const CHECK_INTERVAL_MS = 5 * 60_000;
/** Send the wrap-up once production has effectively stopped for the day. */
const DUSK_POWER_THRESHOLD_W = 50;

/**
 * Sends one "day wrap" push per local day, shortly after production ends —
 * production, revenue, peak, and any home charging that happened.
 */
@Injectable()
export class DailySummaryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DailySummaryService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastSentDate: string | null = null;
  private lastMonthlySent: string | null = null;

  constructor(
    private readonly collector: CollectorService,
    private readonly readings: ReadingsService,
    private readonly charger: ChargerService,
    private readonly notifier: NotifierService,
    private readonly alerts: AlertsService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.maybeSend(), CHECK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async maybeSend(): Promise<void> {
    await this.maybeSendMonthly();

    const snapshot = this.collector.getLastSnapshot();
    if (!snapshot) return;
    const today = localDateOf(new Date());
    // Only after the sun is effectively down, and only once per day.
    if (snapshot.totalPower > DUSK_POWER_THRESHOLD_W) return;
    if (this.lastSentDate === today) return;
    // Guard against firing at pre-dawn 0 W: require real production today.
    if (snapshot.dailyEnergyWh < 1000) return;

    try {
      const stats = await this.readings.getEnergyStats();
      const chargerLive = this.charger.getLive();
      const kwh = (snapshot.dailyEnergyWh / 1000).toFixed(1);
      const revenue = ((snapshot.dailyEnergyWh / 1000) * stats.pricePerKwh).toFixed(2);
      const peak = (stats.records.peakPowerW / 1000).toFixed(1);
      const isRecord = stats.records.bestDayDate === today;

      let text = `${kwh} kWh · $${revenue} · peak ${peak} kW`;
      if (isRecord) text += ' 🏆 new record';
      if (chargerLive && chargerLive.sessionEnergyWh > 0) {
        text += `\nEV: ${(chargerLive.sessionEnergyWh / 1000).toFixed(1)} kWh this session`;
      }

      // Everything held back during the day rides along here rather than arriving as
      // its own interruption. One message a day instead of a push per flap.
      const digest = await this.alerts.takeDigest();
      if (digest) text += `\n\n${digest}`;

      await this.notifier.send(text, { title: '☀️ Solar day wrap', tags: 'sunny' });
      this.lastSentDate = today;
      this.logger.log(`Sent daily summary for ${today}`);
    } catch (error) {
      this.logger.warn(`Daily summary failed: ${(error as Error).message}`);
    }
  }

  /** On the first local day of a month, once, wrap up the month that just ended. */
  private async maybeSendMonthly(): Promise<void> {
    const now = new Date();
    const today = localDateOf(now); // YYYY-MM-DD
    if (!today.endsWith('-01')) return;
    const thisMonth = today.slice(0, 7);
    if (this.lastMonthlySent === thisMonth) return;

    try {
      const daily = await this.readings.getDailyEnergy(70);
      const prevMonth = localDateOf(new Date(now.getTime() - 3 * 86_400_000)).slice(0, 7);
      const rows = daily.filter((d) => d.date.startsWith(prevMonth));
      if (!rows.length) {
        this.lastMonthlySent = thisMonth;
        return;
      }
      const wh = rows.reduce((a, d) => a + d.energyWh, 0);
      const best = rows.reduce((b, d) => (d.energyWh > b.energyWh ? d : b));
      const stats = await this.readings.getEnergyStats();
      const revenue = (wh / 1000) * stats.pricePerKwh;
      const label = new Date(`${prevMonth}-15T12:00:00`).toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      });
      await this.notifier.send(
        `${label}: ${(wh / 1000).toFixed(0)} kWh · $${revenue.toFixed(2)} · ` +
          `best day ${(best.energyWh / 1000).toFixed(1)} kWh · ${rows.length} days`,
        { title: '📅 Monthly solar report', tags: 'calendar' },
      );
      this.lastMonthlySent = thisMonth;
      this.logger.log(`Sent monthly report for ${prevMonth}`);
    } catch (error) {
      this.logger.warn(`Monthly report failed: ${(error as Error).message}`);
    }
  }
}
