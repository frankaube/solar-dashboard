import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BankStatus, CreditReading, DEFAULT_EXPIRY, ExpiryRule, bankStatus, nextExpiry } from './credit-bank';
import { DumpPlan, TREND_DAYS, averageChargeKw, planDump } from './credit-dump';
import { DerivedBank, deriveBank } from './credit-derivation';
import { UtilityImportService } from './utility-import.service';
import { ReadingsService } from './readings.service';
import { localDateOf } from '../common/localdate';
import { ChargerService } from '../charger/charger.service';

export const CREDIT_EXPIRY_MONTH = 'credit.expiryMonth';
export const CREDIT_EXPIRY_DAY = 'credit.expiryDay';
/** Wider than any real history — the derivation is bounded by the meter data, not by this. */
const DERIVATION_DAYS = 4000;

/**
 * Tracking the export-credit bank.
 *
 * The balance starts as a figure typed off a bill, because a running total predates anything
 * this app has seen; imported meter data then carries it forward day by day (`derived`) and
 * projects it to the expiry date (`dumpPlan`). A bill, a derivation and a projection are
 * three degrees of certainty and are reported separately.
 */
@Injectable()
export class CreditBankService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly utility: UtilityImportService,
    private readonly readings: ReadingsService,
    private readonly charger: ChargerService,
  ) {}

  private async setting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  /** The tariff's banking year end. Configurable because it is a utility's choice, not a law. */
  async expiryRule(): Promise<ExpiryRule> {
    const [month, day] = await Promise.all([
      this.setting(CREDIT_EXPIRY_MONTH),
      this.setting(CREDIT_EXPIRY_DAY),
    ]);
    const m = Number(month);
    const d = Number(day);
    return {
      month: Number.isInteger(m) && m >= 1 && m <= 12 ? m : DEFAULT_EXPIRY.month,
      day: Number.isInteger(d) && d >= 1 && d <= 31 ? d : DEFAULT_EXPIRY.day,
    };
  }

  async list(): Promise<Array<{ id: number; readAt: string; balanceKwh: number; note: string | null }>> {
    const rows = await this.prisma.creditReading.findMany({ orderBy: { readAt: 'desc' } });
    return rows.map((row) => ({
      id: row.id,
      readAt: row.readAt.toISOString(),
      balanceKwh: row.balanceKwh,
      note: row.note,
    }));
  }

  async add(input: { readAt?: string; balanceKwh?: number; note?: string }): Promise<void> {
    const balance = Number(input.balanceKwh);
    if (!Number.isFinite(balance) || balance < 0) {
      throw new BadRequestException('balanceKwh must be a number of kWh, zero or more');
    }
    const readAt = input.readAt ? new Date(input.readAt) : new Date();
    if (Number.isNaN(readAt.getTime())) throw new BadRequestException('readAt is not a date');
    // A future-dated reading would drag the projection toward a balance nobody has seen;
    // the likely cause is a typo in the year.
    if (readAt.getTime() > Date.now() + 86_400_000) {
      throw new BadRequestException('readAt is in the future — check the date on the bill');
    }
    await this.prisma.creditReading.create({
      data: { readAt, balanceKwh: balance, note: input.note?.trim() || null },
    });
  }

  async remove(id: number): Promise<void> {
    await this.prisma.creditReading.deleteMany({ where: { id } });
  }

  /**
   * The balance counted from the meter. Anchored to the newest bill: a running total cannot
   * be derived from flows alone, only carried forward from a known one. With no bill this
   * still answers, reporting the change rather than a balance — see `credit-derivation.ts`.
   */
  async derived(): Promise<DerivedBank> {
    const [rows, days, production] = await Promise.all([
      this.prisma.creditReading.findMany({ orderBy: { readAt: 'desc' } }),
      this.utility.meterDays(),
      this.readings.getDailyEnergy(DERIVATION_DAYS),
    ]);
    // Counting forward from the most recent known balance minimises the derived window, and
    // therefore the drift.
    const newest = rows[0];
    const anchor = newest
      ? { date: localDateOf(newest.readAt), balanceKwh: newest.balanceKwh }
      : null;
    return deriveBank(
      anchor,
      days,
      new Map(production.map((row) => [row.date, row.energyWh / 1000])),
    );
  }

  /**
   * What is about to be forfeited, and what draw would absorb it. Advisory only: it never
   * commands a charger.
   *
   * Prefers the derived balance over a typed one — the derivation is the same anchor plus
   * every meter day since, so it is strictly more current than the bill alone.
   */
  async dumpPlan(redeemedRatePerKwh: number, now = new Date()): Promise<DumpPlan> {
    const [derived, days, rule, sessions] = await Promise.all([
      this.derived().catch(() => null),
      this.utility.meterDays().catch(() => []),
      this.expiryRule(),
      this.charger
        .getSessions(TREND_DAYS)
        .then((r) => r.sessions)
        .catch(() => []),
    ]);
    return planDump({
      balanceKwh: derived?.balanceKwh ?? null,
      expiresAt: nextExpiry(now, rule),
      now,
      meterDays: days,
      redeemRatePerKwh: redeemedRatePerKwh,
      averageChargeKw: averageChargeKw(sessions),
    });
  }

  /**
   * @param redeemedRatePerKwh what a banked kWh returns when spent. Under net metering
   *   with tax on buyback that is the pre-tax retail rate, not retail — pricing a forfeit
   *   at full retail overstates the loss by the tax rate.
   */
  async status(redeemedRatePerKwh: number, now = new Date()): Promise<BankStatus> {
    const rows = await this.prisma.creditReading.findMany({ orderBy: { readAt: 'asc' } });
    const readings: CreditReading[] = rows.map((row) => ({
      readAt: row.readAt,
      balanceKwh: row.balanceKwh,
    }));
    return bankStatus({
      readings,
      now,
      redeemedRatePerKwh,
      rule: await this.expiryRule(),
    });
  }
}
