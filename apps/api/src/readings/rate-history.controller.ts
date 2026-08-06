import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SavingsService } from './savings.service';

/**
 * Recorded rate changes.
 *
 * Empty on every install until somebody enters one, and the app falls back to the single
 * configured price — so this endpoint existing changes nothing until it is used.
 */
@Controller('rates')
export class RateHistoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly savings: SavingsService,
  ) {}

  @Get()
  async list(): Promise<object> {
    const rows = await this.prisma.rateEntry.findMany({ orderBy: { effectiveFrom: 'desc' } });
    return rows.map((row) => ({
      id: row.id,
      effectiveFrom: row.effectiveFrom,
      pricePerKwh: row.pricePerKwh,
      hstRate: row.hstRate,
      priceIncludesTax: row.priceIncludesTax,
      note: row.note,
    }));
  }

  @Post()
  async add(
    @Body()
    body: {
      effectiveFrom?: unknown;
      pricePerKwh?: unknown;
      hstRate?: unknown;
      priceIncludesTax?: unknown;
      note?: unknown;
    },
  ): Promise<object> {
    const effectiveFrom = String(body.effectiveFrom ?? '').trim();
    /*
      A date, and only a date. The rate applies from a day, not an instant — bills change
      on a date — and accepting a timestamp would invite a timezone question that has no
      good answer for a figure printed on paper.
    */
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      throw new BadRequestException('effectiveFrom must be a date, as YYYY-MM-DD.');
    }
    const price = Number(body.pricePerKwh);
    if (!Number.isFinite(price) || price <= 0) {
      throw new BadRequestException('pricePerKwh must be a positive number.');
    }
    /*
      A price above a dollar a kilowatt-hour is a unit error — cents typed where dollars
      were meant — roughly every time. Caught here because the mistake is invisible
      afterwards: every figure in the app simply becomes a hundred times too large.
    */
    if (price > 1) {
      throw new BadRequestException('That looks like cents. Enter dollars per kWh, e.g. 0.18.');
    }
    const hstRate = Number(body.hstRate);
    if (!Number.isFinite(hstRate) || hstRate < 0 || hstRate >= 1) {
      throw new BadRequestException('hstRate must be a fraction below 1, e.g. 0.15.');
    }

    const data = {
      effectiveFrom,
      pricePerKwh: price,
      hstRate,
      priceIncludesTax: body.priceIncludesTax !== false,
      note: body.note === undefined || body.note === null ? null : String(body.note).trim() || null,
    };
    // One rate per start date: recording the same change twice revises it rather than
    // leaving two rows whose order decides the answer.
    await this.prisma.rateEntry.upsert({ where: { effectiveFrom }, create: data, update: data });
    this.savings.invalidate();
    return this.list();
  }

  @Delete(':id')
  async remove(@Param('id', ParseIntPipe) id: number): Promise<object> {
    await this.prisma.rateEntry.deleteMany({ where: { id } });
    this.savings.invalidate();
    return this.list();
  }
}
