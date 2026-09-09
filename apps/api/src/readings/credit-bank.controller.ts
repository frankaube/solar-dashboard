import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreditBankService } from './credit-bank.service';

const PRICE_SETTING_KEY = 'electricityPricePerKwh';
const HST_SETTING_KEY = 'hstRate';
const DEFAULT_PRICE = 0.16;
const DEFAULT_HST = 0.15;

@Controller('credits')
export class CreditBankController {
  constructor(
    private readonly credits: CreditBankService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * What a banked kWh is worth when spent: pre-tax retail, not retail. Under 1:1 net
   * metering the credit returns a kWh but buying it back attracts sales tax, so the credit
   * offsets only the energy. Same reasoning as the net-metering export-credit line.
   */
  private async redeemRate(): Promise<number> {
    const read = async (key: string, fallback: number): Promise<number> => {
      const row = await this.prisma.setting.findUnique({ where: { key } });
      const value = Number(row?.value);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    const retail = await read(PRICE_SETTING_KEY, DEFAULT_PRICE);
    const tax = await read(HST_SETTING_KEY, DEFAULT_HST);
    return retail / (1 + tax);
  }

  @Get()
  async status(): Promise<object> {
    const [status, readings, rate, derived, dump] = await Promise.all([
      this.redeemRate().then((r) => this.credits.status(r)),
      this.credits.list(),
      this.redeemRate(),
      // Never fatal: the derivation needs imported meter data, which most installs lack, and
      // the typed balances above must survive its absence.
      this.credits.derived().catch(() => null),
      // Deadline advice. Never fatal, same reason.
      this.redeemRate().then((r) => this.credits.dumpPlan(r)).catch(() => null),
    ]);
    return { ...status, readings, redeemRatePerKwh: Number(rate.toFixed(5)), derived, dump };
  }

  @Post()
  async add(@Body() body: { readAt?: string; balanceKwh?: number; note?: string }): Promise<object> {
    await this.credits.add(body ?? {});
    return this.status();
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number): Promise<object> {
    await this.credits.remove(id);
    return this.status();
  }
}
