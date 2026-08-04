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
   * What a banked kWh is worth when spent.
   *
   * Pre-tax retail, not retail. Under 1:1 net metering the credit returns a kWh, but
   * buying that kWh back attracts sales tax — so the credit offsets only the energy, and
   * pricing a forfeited one at full retail overstates the loss by the tax rate. This is the
   * same reasoning the net-metering program uses for its export-credit line.
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
    const [status, readings, rate, derived] = await Promise.all([
      this.redeemRate().then((r) => this.credits.status(r)),
      this.credits.list(),
      this.redeemRate(),
      /*
        Never fatal. The derivation reads imported meter data, which most installs do not
        have — and the typed balances above are the older, load-bearing half of this
        endpoint. They must not disappear because the newer half had nothing to say.
      */
      this.credits.derived().catch(() => null),
    ]);
    return { ...status, readings, redeemRatePerKwh: Number(rate.toFixed(5)), derived };
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
