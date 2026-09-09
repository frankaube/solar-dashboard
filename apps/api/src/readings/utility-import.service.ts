import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReadingsService } from './readings.service';
import { readSheet, type CellValue } from './xlsx';
import { parseGreenButton } from './green-button';
import { localDateOf } from '../common/localdate';
import {
  ColumnMapping,
  UtilityDay,
  describeUncomparable,
  describeUnmetered,
  detectColumns,
  parseRows,
  uncomparableDays,
  unmeteredDays,
} from './utility-usage';

/**
 * Importing a utility's usage export. Spreadsheet and CSV both become the same grid of
 * cells, so the format question is answered at the door and never again.
 */

const LIFETIME_DAYS = 4000;

export interface ImportPreview {
  /** Null when the columns were not recognised — then `headers` is what a person maps. */
  mapping: ColumnMapping | null;
  headers: string[];
  headerRow: number | null;
  readings: UtilityDay[];
  problems: string[];
  /** Days the array produced and the meter recorded nothing leaving. */
  unmetered: Array<{ date: string; producedKwh: number }>;
  unmeteredNote: string | null;
  /** Days with no production on this side, which therefore cannot move any figure. */
  uncomparable: string[];
  uncomparableNote: string | null;
}

@Injectable()
export class UtilityImportService {
  private readonly logger = new Logger(UtilityImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly readings: ReadingsService,
  ) {}

  /**
   * Turn an uploaded file into a grid. CSV is split on a spreadsheet's quoting rules, not
   * on commas: a meter description containing a comma shifts every column after it.
   */
  private toGrid(file: Buffer, filename: string): CellValue[][] {
    if (/\.xlsx?$/i.test(filename)) return readSheet(file);
    // XML is Green Button's business, handled before this.
    if (/\.xml$/i.test(filename)) return [];
    const text = file.toString('utf8').replace(/^﻿/, '');
    return text.split(/\r?\n/).map((line) => this.splitCsvLine(line));
  }

  private splitCsvLine(line: string): CellValue[] {
    const cells: CellValue[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const character = line[i];
      if (quoted) {
        // A doubled quote inside a quoted field is one literal quote.
        if (character === '"' && line[i + 1] === '"') { current += '"'; i++; }
        else if (character === '"') quoted = false;
        else current += character;
      } else if (character === '"') quoted = true;
      else if (character === ',') { cells.push(current.trim() === '' ? null : current.trim()); current = ''; }
      else current += character;
    }
    cells.push(current.trim() === '' ? null : current.trim());
    return cells;
  }

  /**
   * What this app can and cannot say about a set of meter days. Shared by both branches of
   * `preview` so the spreadsheet and Green Button paths cannot disagree about the same days.
   */
  private async compareAgainstProduction(readings: UtilityDay[]): Promise<
    Pick<ImportPreview, 'unmetered' | 'unmeteredNote' | 'uncomparable' | 'uncomparableNote'>
  > {
    const daily = await this.readings.getDailyEnergy(LIFETIME_DAYS);
    const produced = new Map(daily.map((row) => [row.date, row.energyWh / 1000]));
    // The first day this app has production for. Computed rather than assuming
    // getDailyEnergy's ordering.
    const earliestProduced = daily
      .filter((row) => row.energyWh > 0)
      .reduce<string | null>((lo, row) => (lo === null || row.date < lo ? row.date : lo), null);
    const unmetered = unmeteredDays(readings, produced);
    const uncomparable = uncomparableDays(readings, produced);
    return {
      unmetered,
      unmeteredNote: describeUnmetered(unmetered),
      uncomparable,
      uncomparableNote: describeUncomparable(uncomparable, earliestProduced),
    };
  }

  /** Read a file and report what it contains, without storing anything. */
  async preview(file: Buffer, filename: string, override?: ColumnMapping): Promise<ImportPreview> {
    let grid: CellValue[][];
    try {
      grid = this.toGrid(file, filename);
    } catch (error) {
      throw new BadRequestException(`Could not read ${filename}: ${String(error)}`);
    }

    /*
      Green Button first: it is the only format that declares what its numbers mean, taking
      direction from the file's own ReadingType rather than a column heading. It returns
      nothing for a file that is not one, so it can be tried without sniffing first.
    */
    if (/\.xml$/i.test(filename) || /IntervalReading/.test(file.subarray(0, 4096).toString('utf8'))) {
      const green = parseGreenButton(file.toString('utf8'), localDateOf);
      if (green.readings.length > 0) {
        return {
          // Nothing to map: the format said which direction each block was.
          mapping: { date: -1, imported: -1, exported: -1 },
          headers: [],
          headerRow: null,
          readings: green.readings,
          problems: green.problems,
          ...(await this.compareAgainstProduction(green.readings)),
        };
      }
    }

    const detection = detectColumns(grid);
    const mapping = override ?? detection.mapping;
    if (!mapping) {
      return {
        mapping: null,
        headers: detection.headers,
        headerRow: detection.headerRow,
        readings: [],
        problems: ['The columns in this file were not recognised — say which is which.'],
        unmetered: [],
        unmeteredNote: null,
        uncomparable: [],
        uncomparableNote: null,
      };
    }

    const startRow = (detection.headerRow ?? -1) + 1;
    const { readings, problems } = parseRows(grid, mapping, startRow);

    return {
      mapping,
      headers: detection.headers,
      headerRow: detection.headerRow,
      readings,
      problems,
      ...(await this.compareAgainstProduction(readings)),
    };
  }

  /** Store a previewed import. Re-importing a period revises those days rather than doubling them. */
  async commit(file: Buffer, filename: string, override?: ColumnMapping): Promise<ImportPreview & { stored: number }> {
    const preview = await this.preview(file, filename, override);
    if (!preview.mapping) throw new BadRequestException(preview.problems[0]);
    if (preview.readings.length === 0) {
      throw new BadRequestException('No readable days in that file — nothing was stored.');
    }

    const flagged = new Set(preview.unmetered.map((day) => day.date));
    for (const reading of preview.readings) {
      const data = {
        importedKwh: reading.importedKwh,
        exportedKwh: reading.exportedKwh,
        source: filename,
        unmetered: flagged.has(reading.date),
        importedAt: new Date(),
      };
      await this.prisma.utilityReading.upsert({
        where: { date: reading.date },
        create: { date: reading.date, ...data },
        update: data,
      });
    }
    this.logger.log(
      `Utility import: ${preview.readings.length} days from ${filename}` +
        (flagged.size ? `, ${flagged.size} flagged as unmetered` : '') +
        (preview.uncomparable.length
          ? `, ${preview.uncomparable.length} with no production to compare against`
          : ''),
    );
    return { ...preview, stored: preview.readings.length };
  }

  /**
   * Export by date, for the days this can speak for. Unmetered days are omitted rather than
   * reported as zero export, which downstream would read as "all of it stayed home".
   */
  async exportedKwhByDate(): Promise<Map<string, number>> {
    const rows = await this.prisma.utilityReading.findMany({
      where: { unmetered: false },
      select: { date: true, exportedKwh: true },
    });
    return new Map(rows.map((row) => [row.date, row.exportedKwh]));
  }

  /**
   * Every imported day, both directions, oldest first. Unlike `exportedKwhByDate` this
   * keeps unmetered days and flags them: the credit bank needs them, since a day the meter
   * counted import but not export still drew the balance down.
   */
  async meterDays(): Promise<
    Array<{ date: string; importedKwh: number; exportedKwh: number; unmetered: boolean }>
  > {
    return this.prisma.utilityReading.findMany({
      orderBy: { date: 'asc' },
      select: { date: true, importedKwh: true, exportedKwh: true, unmetered: true },
    });
  }

  /** What the Settings page shows about what has been imported. */
  async status(): Promise<{
    days: number;
    firstDate: string | null;
    lastDate: string | null;
    unmeteredDays: number;
    source: string | null;
  }> {
    const [count, first, last, unmetered] = await Promise.all([
      this.prisma.utilityReading.count(),
      this.prisma.utilityReading.findFirst({ orderBy: { date: 'asc' } }),
      this.prisma.utilityReading.findFirst({ orderBy: { date: 'desc' } }),
      this.prisma.utilityReading.count({ where: { unmetered: true } }),
    ]);
    return {
      days: count,
      firstDate: first?.date ?? null,
      lastDate: last?.date ?? null,
      unmeteredDays: unmetered,
      source: last?.source ?? null,
    };
  }
}
