import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BankStatus, CreditReading, DEFAULT_EXPIRY, ExpiryRule, bankStatus } from './credit-bank';

export const CREDIT_EXPIRY_MONTH = 'credit.expiryMonth';
export const CREDIT_EXPIRY_DAY = 'credit.expiryDay';

/**
 * Tracking the export-credit bank.
 *
 * The balance is entered from a bill rather than measured: this app sees production, not
 * what crosses the meter, so it genuinely cannot know. Every number here is therefore only
 * as current as the last bill — which the status makes explicit rather than presenting a
 * three-month-old figure as today's.
 */
@Injectable()
export class CreditBankService {
  constructor(private readonly prisma: PrismaService) {}

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
