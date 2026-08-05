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
 * The balance starts as a figure typed off a bill, because a running total predates
 * anything this app has seen. It no longer ends there: imported meter data carries it
 * forward day by day (`derived`), and projects it to the expiry date to say what is about
 * to be forfeited (`dumpPlan`). What each number rests on is stated rather than blended —
 * a bill, a derivation, and a projection are three different degrees of certainty.
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
    /*
      A future-dated reading would drag a projection toward a balance nobody has seen yet,
      and the most likely cause is a typo in the year. Refused rather than absorbed.
    */
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
   * The balance counted from the meter, rather than waited for.
   *
   * Anchored to the newest bill on or before the meter data — a running total cannot be
   * derived from flows alone, only carried forward from a known one. With no bill at all
   * this still answers, with the change since the data begins and an explicit refusal to
   * call it a balance; see `credit-derivation.ts`.
   */
  async derived(): Promise<DerivedBank> {
    const [rows, days, production] = await Promise.all([
      this.prisma.creditReading.findMany({ orderBy: { readAt: 'desc' } }),
      this.utility.meterDays(),
      this.readings.getDailyEnergy(DERIVATION_DAYS),
    ]);
    /*
      The newest bill that is not after the meter data starts would be ideal, but any
      newest bill is better: counting forward from the most recent known balance minimises
      the window that has to be derived, and therefore the drift.
    */
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
   * What is about to be forfeited, and what draw would absorb it.
   *
   * Advisory only. It reads the meter and projects; it never commands a charger. Drawing
   * power costs money when the projection is wrong, so the decision stays with the owner.
   *
   * Prefers the derived balance over a typed one — the derivation counts forward from the
   * last bill using daily meter readings, so it is the same anchor plus everything that
   * has happened since, which is strictly more current than the bill alone.
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
