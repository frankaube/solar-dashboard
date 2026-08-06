import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ImportPlan, parseExport, planImport } from './cloud-import';

/**
 * Filling a gap in the power history, from the app rather than from a terminal.
 *
 * The rules live in cloud-import.ts and are tested there. This is the part that has to touch
 * the database, and it keeps two properties the CLI version had:
 *
 *  - Preview and apply are the same computation. What somebody is shown before they commit
 *    is produced by the same code that does the writing, so the preview cannot drift from
 *    the outcome.
 *  - Nothing is ever updated. Rows are only ever inserted where no reading exists, and undo
 *    deletes only rows this wrote — matched on `source = 'cloud'`, never on a time range.
 */

export interface ImportSummary {
  dates: string[];
  /** Rows that would be, or were, written. */
  inserted: number;
  /** Points refused because a real reading already covers that moment. */
  covered: number;
  rejected: number;
  perDay: ImportPlan['perDay'];
  /** Local-time bounds of what is being written, for the confirmation line. */
  from: string | null;
  to: string | null;
  applied: boolean;
}

@Injectable()
export class CloudImportService {
  private readonly logger = new Logger(CloudImportService.name);

  constructor(private readonly prisma: PrismaService) {}

  private zone(): string {
    return process.env.SITE_TIMEZONE || 'UTC';
  }

  /**
   * Work out what an export would do.
   *
   * `apply` is a parameter rather than a separate method so there is exactly one path
   * through this. A preview that is computed differently from the write is a preview that
   * can lie, and this writes into the only copy of the measurement history.
   */
  async run(text: string, options: { fallbackDate?: string; apply: boolean }): Promise<ImportSummary> {
    const zone = this.zone();
    const parsed = parseExport(text, { zone, fallbackDate: options.fallbackDate });
    if (!parsed.points.length) {
      return {
        dates: [],
        inserted: 0,
        covered: 0,
        rejected: parsed.rejected,
        perDay: [],
        from: null,
        to: null,
        applied: false,
      };
    }

    const dtu = await this.prisma.dtu.findFirst({ orderBy: { id: 'asc' } });
    if (!dtu) throw new Error('No gateway recorded yet — there is nothing to attach readings to.');

    // Only the days the export touches. Loading the whole table to answer a question about
    // one morning would be the kind of query that is fine until somebody has three years.
    const existing = await this.prisma.dtuReading.findMany({
      where: { dtuId: dtu.id, localDate: { in: parsed.dates } },
      select: { takenAt: true, localDate: true, dailyEnergy: true },
    });

    const plan = planImport(parsed.points, existing);
    const summary: ImportSummary = {
      dates: plan.dates,
      inserted: plan.insert.length,
      covered: plan.covered,
      rejected: parsed.rejected,
      perDay: plan.perDay,
      from: plan.insert[0]?.at.toISOString() ?? null,
      to: plan.insert[plan.insert.length - 1]?.at.toISOString() ?? null,
      applied: false,
    };

    if (!options.apply || !plan.insert.length) return summary;

    await this.prisma.dtuReading.createMany({
      data: plan.insert.map((row) => ({
        dtuId: dtu.id,
        takenAt: row.at,
        localDate: row.localDate,
        totalPower: row.watts,
        dailyEnergy: row.dailyEnergy,
        source: 'cloud',
      })),
    });
    this.logger.log(
      `Imported ${plan.insert.length} cloud reading(s) for ${plan.dates.join(', ')}; ` +
        `${plan.covered} already covered by polled readings.`,
    );
    return { ...summary, applied: true };
  }

  /**
   * Remove imported rows for a day.
   *
   * Matched on `source = 'cloud'`, so it can only ever delete what an import wrote. Deleting
   * by time range would take polled readings with it, and those cannot be recovered from
   * anywhere.
   */
  async undo(localDate: string): Promise<{ removed: number }> {
    const { count } = await this.prisma.dtuReading.deleteMany({
      where: { source: 'cloud', localDate },
    });
    this.logger.log(`Removed ${count} imported reading(s) for ${localDate}.`);
    return { removed: count };
  }

  /** What has been imported, so it is visible rather than only inferable from a chart. */
  async imported(): Promise<Array<{ localDate: string; rows: number }>> {
    const rows = await this.prisma.dtuReading.groupBy({
      by: ['localDate'],
      where: { source: 'cloud' },
      _count: { _all: true },
      orderBy: { localDate: 'desc' },
    });
    return rows.map((row) => ({ localDate: row.localDate, rows: row._count._all }));
  }
}
