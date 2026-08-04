import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReadingsService } from './readings.service';
import { readSheet, type CellValue } from './xlsx';
import { parseGreenButton } from './green-button';
import { localDateOf } from '../common/localdate';
import {
  ColumnMapping,
  UtilityDay,
  describeUnmetered,
  detectColumns,
  parseRows,
  unmeteredDays,
} from './utility-usage';

/**
 * Importing a utility's usage export, and saying honestly what came of it.
 *
 * Two shapes arrive here: a spreadsheet, and a CSV. Both become the same grid of cells, so
 * everything past this point is one code path — the format question is answered at the
 * door and never again.
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
}

@Injectable()
export class UtilityImportService {
  private readonly logger = new Logger(UtilityImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly readings: ReadingsService,
  ) {}

  /**
   * Turn an uploaded file into a grid.
   *
   * CSV is split on the quoting rules a spreadsheet actually writes, rather than on commas
   * — a meter description containing a comma would otherwise shift every column after it,
   * which is the same silent misalignment the XLSX reader had to be fixed for twice.
   */
  private toGrid(file: Buffer, filename: string): CellValue[][] {
    if (/\.xlsx?$/i.test(filename)) return readSheet(file);
    // XML is Green Button's business and is handled before this; splitting it on commas
    // would produce a grid of angle brackets that detection then has to reject.
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
   * Read a file and report what it contains — without storing anything.
   *
   * Separate from the commit on purpose. An import that both parses and saves gives a
   * person no moment to notice that a column was mapped the wrong way round, and by the
   * time the savings page looks odd the original file is closed.
   */
  async preview(file: Buffer, filename: string, override?: ColumnMapping): Promise<ImportPreview> {
    let grid: CellValue[][];
    try {
      grid = this.toGrid(file, filename);
    } catch (error) {
      throw new BadRequestException(`Could not read ${filename}: ${String(error)}`);
    }

    /*
      Green Button first, because it is the only format that declares what its numbers
      mean. Direction comes from the file's own ReadingType rather than from a column
      heading somebody has to interpret, so where a feed is present there is nothing to
      map and nothing to get backwards. It returns nothing at all for a file that is not
      one, which is why this can be tried without sniffing first.
    */
    if (/\.xml$/i.test(filename) || /IntervalReading/.test(file.subarray(0, 4096).toString('utf8'))) {
      const green = parseGreenButton(file.toString('utf8'), localDateOf);
      if (green.readings.length > 0) {
        const daily = await this.readings.getDailyEnergy(LIFETIME_DAYS);
        const produced = new Map(daily.map((row) => [row.date, row.energyWh / 1000]));
        const unmetered = unmeteredDays(green.readings, produced);
        return {
          // Nothing to map: the format said which direction each block was.
          mapping: { date: -1, imported: -1, exported: -1 },
          headers: [],
          headerRow: null,
          readings: green.readings,
          problems: green.problems,
          unmetered,
          unmeteredNote: describeUnmetered(unmetered),
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
      };
    }

    const startRow = (detection.headerRow ?? -1) + 1;
    const { readings, problems } = parseRows(grid, mapping, startRow);

    const daily = await this.readings.getDailyEnergy(LIFETIME_DAYS);
    const produced = new Map(daily.map((row) => [row.date, row.energyWh / 1000]));
    const unmetered = unmeteredDays(readings, produced);

    return {
      mapping,
      headers: detection.headers,
      headerRow: detection.headerRow,
      readings,
      problems,
      unmetered,
      unmeteredNote: describeUnmetered(unmetered),
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
        (flagged.size ? `, ${flagged.size} flagged as unmetered` : ''),
    );
    return { ...preview, stored: preview.readings.length };
  }

  /**
   * Export by date, for the days this can speak for.
   *
   * Unmetered days are left out entirely rather than reported as zero export. Zero would
   * be read downstream as "all of it stayed home", which is the precise opposite of what
   * a meter that was not counting actually tells you.
   */
  async exportedKwhByDate(): Promise<Map<string, number>> {
    const rows = await this.prisma.utilityReading.findMany({
      where: { unmetered: false },
      select: { date: true, exportedKwh: true },
    });
    return new Map(rows.map((row) => [row.date, row.exportedKwh]));
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
