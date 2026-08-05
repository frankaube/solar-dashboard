import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { buildInfo } from '../common/build-info';
import { localDateOf } from '../common/localdate';
import { Grouping, bucketProduction, describeBuckets } from './production-buckets';
import { CollectorService } from '../collector/collector.service';
import { AlertsService } from '../alerts/alerts.service';
import { AnalyticsService } from './analytics.service';
import { DegradationService } from './degradation.service';
import { UtilityImportService } from './utility-import.service';
import type { ColumnMapping } from './utility-usage';
import { ReadingsService } from './readings.service';
import { SavingsService } from './savings.service';
import { PROGRAM_OPTIONS } from './reward-programs';

const DEFAULT_HISTORY_HOURS = 24;
const MAX_HISTORY_HOURS = 24 * 31;
const DEFAULT_ENERGY_DAYS = 30;
const MAX_ENERGY_DAYS = 3660;
const DEFAULT_EXPORT_HOURS = 24 * 7;
const ROLLUP_EXPORT_DAYS = 365;
const DEFAULT_SCATTER_HOURS = 24 * 7;
const MAX_PANEL_LABEL_LENGTH = 64;

function parseBounded(raw: string | undefined, fallback: number, max: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > max) {
    throw new BadRequestException(`Value must be between 1 and ${max}`);
  }
  return value;
}

function sendCsv(res: Response, filename: string, header: string, lines: string[]): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send([header, ...lines].join('\n'));
}

@Controller()
export class ReadingsController {
  constructor(
    private readonly readings: ReadingsService,
    private readonly prisma: PrismaService,
    private readonly collector: CollectorService,
    private readonly alerts: AlertsService,
    private readonly analytics: AnalyticsService,
    private readonly savings: SavingsService,
    private readonly degradation: DegradationService,
    private readonly utility: UtilityImportService,
  ) {}

  @Get('analytics/production')
  getProductionAnalytics(@Query('hours') hours?: string): object {
    return this.analytics.getProductionAnalytics(
      parseBounded(hours, DEFAULT_HISTORY_HOURS, MAX_HISTORY_HOURS),
    );
  }

  @Get('analytics/temp-power')
  getTemperaturePower(@Query('hours') hours?: string): object {
    return this.analytics.getTemperaturePower(
      parseBounded(hours, DEFAULT_SCATTER_HOURS, MAX_HISTORY_HOURS),
    );
  }

  @Get('analytics/voltage-power')
  getVoltagePower(@Query('hours') hours?: string): object {
    return this.analytics.getVoltagePower(
      parseBounded(hours, DEFAULT_SCATTER_HOURS, MAX_HISTORY_HOURS),
    );
  }

  /**
   * Panel degradation from this array's own learned response.
   *
   * Answers "not yet, and here is how much longer" for the first two years, because a
   * slope fitted over less than that is measuring the seasonal sun angle.
   */
  @Get('analytics/degradation')
  getDegradation(): Promise<object> {
    return this.degradation.getDegradation();
  }

  /** What has been imported from the utility's own meter, if anything. */
  @Get('utility-usage')
  getUtilityUsage(): Promise<object> {
    return this.utility.status();
  }

  /**
   * Import a utility usage export.
   *
   * `?commit=false` reads the file and reports what it found without storing anything —
   * the default, deliberately. An import that parses and saves in one step gives nobody a
   * moment to notice that a column was mapped the wrong way round, and by the time the
   * savings page looks odd the original file is closed.
   *
   * The body is the raw file. `filename` decides between spreadsheet and CSV; `mapping` is
   * only needed when the columns were not recognised, and is the mechanism by which a
   * utility nobody has seen before works anyway.
   */
  @Post('utility-usage')
  async importUtilityUsage(
    @Query('filename') filename?: string,
    @Query('commit') commit?: string,
    @Query('mapping') mapping?: string,
    @Body() body?: Buffer,
  ): Promise<object> {
    if (!body || body.length === 0) throw new BadRequestException('no file uploaded');
    const name = (filename ?? 'usage.csv').trim();
    let override: ColumnMapping | undefined;
    if (mapping) {
      try {
        override = JSON.parse(mapping) as ColumnMapping;
      } catch {
        throw new BadRequestException('mapping must be JSON, e.g. {"date":0,"imported":1,"exported":2}');
      }
      const columns = [override?.date, override?.imported, override?.exported];
      if (columns.some((column) => !Number.isInteger(column) || (column as number) < 0)) {
        throw new BadRequestException('mapping needs date, imported and exported column numbers');
      }
    }
    return commit === 'true'
      ? this.utility.commit(body, name, override)
      : this.utility.preview(body, name, override);
  }

  @Get('analytics/panels')
  getPanelInsights(@Query('days') days?: string): object {
    const parsed = Number(days ?? 7);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 90) {
      throw new BadRequestException('days must be between 1 and 90');
    }
    return this.analytics.getPanelInsights(parsed);
  }

  @Get('live')
  getLive(): object {
    return { snapshot: this.readings.getLive() };
  }

  @Get('summary')
  getSummary(): object {
    return this.readings.getSummary();
  }

  @Get('stats')
  getStats(): object {
    return this.readings.getEnergyStats();
  }

  @Get('records')
  getRecords(): object {
    return this.readings.getMilestones();
  }

  @Get('savings')
  getSavings(): object {
    return this.savings.getSavings();
  }

  /**
   * The self-consumption share as the meter measures it, for Settings to offer.
   *
   * Separate from `savings` because it answers a different question: not "what were the
   * numbers" but "should the number you typed still be the one in use".
   */
  @Get('savings/self-consumption')
  getSelfConsumptionEstimate(): object {
    return this.savings.selfConsumptionEstimate();
  }

  @Get('history/power')
  getPowerHistory(@Query('hours') hours?: string): object {
    return this.readings.getPowerHistory(
      parseBounded(hours, DEFAULT_HISTORY_HOURS, MAX_HISTORY_HOURS),
    );
  }

  @Get('history/energy')
  getEnergyHistory(@Query('days') days?: string): object {
    return this.readings.getDailyEnergy(parseBounded(days, DEFAULT_ENERGY_DAYS, MAX_ENERGY_DAYS));
  }

  /**
   * Production totalled by day, month or year, for comparing periods.
   *
   * The window is only as deep as the grouping can use. This pulled MAX_ENERGY_DAYS — ten
   * years — for every request including the day view, which is a groupBy over the entire
   * reading table on a five-minute poll, per open tab, to draw at most a few months of
   * bars. Years still asks for everything, because that is what a year comparison is.
   */
  @Get('history/production')
  async getProduction(
    @Query('grouping') grouping?: string,
    @Query('days') days?: string,
  ): Promise<object> {
    const group: Grouping =
      grouping === 'month' || grouping === 'year' ? grouping : 'day';
    /*
      The grouping's own ceiling, and what a caller may ask for inside it.

      Kept because they are different concerns: the ceiling protects the Pi from a groupBy
      over the whole reading table on a five-minute poll, and the caller's `days` is the
      range the page's own selector asks for. That selector used to reach exactly one panel
      out of six — it sat above this chart and did nothing to it, which reads as a broken
      control rather than a narrow one.
    */
    const ceiling = group === 'day' ? 400 : group === 'month' ? 800 : MAX_ENERGY_DAYS;
    const requested = Number(days);
    const window =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, ceiling)
        : group === 'day'
          ? 120
          : ceiling;
    const daily = await this.readings.getDailyEnergy(window);
    const buckets = bucketProduction(daily, group, localDateOf(new Date()));
    return { grouping: group, buckets, summary: describeBuckets(buckets, group) };
  }

  @Get('history/port/:id')
  getPortHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query('hours') hours?: string,
  ): object {
    return this.readings.getPortHistory(
      id,
      parseBounded(hours, DEFAULT_HISTORY_HOURS, MAX_HISTORY_HOURS),
    );
  }

  @Get('history/weather')
  getWeatherHistory(@Query('hours') hours?: string): object {
    return this.readings.getWeatherHistory(
      parseBounded(hours, DEFAULT_HISTORY_HOURS, MAX_HISTORY_HOURS),
    );
  }

  /**
   * Which build is serving this, and nothing else.
   *
   * Separate from /api/status because the browser polls this once a minute per open tab to
   * notice that it is running superseded code, and /api/status counts four tables to answer
   * a question nobody asked here.
   */
  @Get('build')
  getBuild(): object {
    return buildInfo();
  }

  @Get('status')
  async getStatus(): Promise<object> {
    const [dtuReadings, inverterReadings, portReadings, openAlerts] = await Promise.all([
      this.prisma.dtuReading.count(),
      this.prisma.inverterReading.count(),
      this.prisma.portReading.count(),
      this.alerts.countOpen(),
    ]);
    return {
      // First field on purpose: this is what a deploy checks to prove the new code is live.
      build: buildInfo(),
      collector: this.collector.getStatus(),
      counts: { dtuReadings, inverterReadings, portReadings },
      openAlerts,
    };
  }

  @Get('panels')
  async getPanels(): Promise<object[]> {
    const ports = await this.prisma.pvPort.findMany({
      include: { microinverter: true },
      orderBy: [{ microinverterId: 'asc' }, { portNumber: 'asc' }],
    });
    return ports.map((port) => ({
      id: port.id,
      portNumber: port.portNumber,
      label: port.panelLabel,
      wattage: port.panelWattage,
      gridX: port.gridX,
      gridY: port.gridY,
      inverterSerial: port.microinverter.serialNumber.toString(),
    }));
  }

  @Put('panels/:id/position')
  async putPanelPosition(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { gridX?: unknown; gridY?: unknown },
  ): Promise<object> {
    const parseCoord = (raw: unknown, name: string): number | null => {
      if (raw === null || raw === undefined) return null;
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 0) {
        throw new BadRequestException(`${name} must be a non-negative integer or null`);
      }
      return value;
    };
    const gridX = parseCoord(body.gridX, 'gridX');
    const gridY = parseCoord(body.gridY, 'gridY');
    if ((gridX === null) !== (gridY === null)) {
      throw new BadRequestException('gridX and gridY must be set together');
    }
    const updated = await this.prisma.pvPort.update({ where: { id }, data: { gridX, gridY } });
    return { id: updated.id, gridX: updated.gridX, gridY: updated.gridY };
  }

  @Put('panels/:id')
  async putPanel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { label?: unknown; wattage?: unknown },
  ): Promise<object> {
    const label = body.label === null || body.label === undefined ? null : String(body.label);
    if (label && label.length > MAX_PANEL_LABEL_LENGTH) {
      throw new BadRequestException(`label must be at most ${MAX_PANEL_LABEL_LENGTH} characters`);
    }
    let wattage: number | null = null;
    if (body.wattage !== null && body.wattage !== undefined && body.wattage !== '') {
      wattage = Number(body.wattage);
      if (!Number.isInteger(wattage) || wattage <= 0) {
        throw new BadRequestException('wattage must be a positive integer');
      }
    }
    const updated = await this.prisma.pvPort.update({
      where: { id },
      data: { panelLabel: label, panelWattage: wattage },
    });
    return { id: updated.id, label: updated.panelLabel, wattage: updated.panelWattage };
  }

  @Get('export/readings.csv')
  async exportReadings(@Res() res: Response, @Query('hours') hours?: string): Promise<void> {
    const bounded = parseBounded(hours, DEFAULT_EXPORT_HOURS, MAX_HISTORY_HOURS);
    const points = await this.readings.getPowerHistory(bounded);
    sendCsv(
      res,
      'readings.csv',
      'timestamp,power_w',
      points.map((point) => `${point.t},${point.powerW}`),
    );
  }

  @Get('export/daily.csv')
  async exportDaily(@Res() res: Response, @Query('days') days?: string): Promise<void> {
    const bounded = parseBounded(days, ROLLUP_EXPORT_DAYS, MAX_ENERGY_DAYS);
    const daily = await this.readings.getDailyEnergy(bounded);
    const config = await this.readings.getConfig();
    sendCsv(
      res,
      'daily-energy.csv',
      'date,energy_wh,energy_kwh,revenue_cad',
      daily.map((row) => {
        const kwh = row.energyWh / 1000;
        return `${row.date},${row.energyWh},${kwh.toFixed(3)},${(kwh * config.electricityPricePerKwh).toFixed(2)}`;
      }),
    );
  }

  @Get('config')
  getConfig(): object {
    return this.readings.getConfig();
  }

  /** The tariffs a user can pick, with the explanation the picker shows. */
  @Get('config/programs')
  getPrograms(): object {
    return PROGRAM_OPTIONS;
  }

  @Put('config')
  async putConfig(
    @Body()
    body: {
      electricityPricePerKwh?: unknown;
      systemCostCad?: unknown;
      hstRate?: unknown;
      systemRatedKw?: unknown;
      rewardProgramId?: unknown;
      priceIncludesTax?: unknown;
      selfConsumptionPct?: unknown;
      selfConsumptionAuto?: unknown;
    },
  ): Promise<object> {
    const parseOptional = (raw: unknown, name: string): number | null => {
      if (raw === undefined || raw === null || raw === '') return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value <= 0) {
        throw new BadRequestException(`${name} must be a positive number`);
      }
      return value;
    };
    const price = parseOptional(body.electricityPricePerKwh, 'electricityPricePerKwh');
    const cost = parseOptional(body.systemCostCad, 'systemCostCad');
    const hstRate = parseOptional(body.hstRate, 'hstRate');
    if (hstRate !== null && hstRate >= 1) {
      throw new BadRequestException('hstRate must be a fraction below 1 (e.g. 0.15)');
    }
    const ratedKw = parseOptional(body.systemRatedKw, 'systemRatedKw');
    if (ratedKw !== null && ratedKw > 1000) {
      throw new BadRequestException('systemRatedKw looks wrong — expected kW, not watts');
    }
    /*
      Checked against the registry rather than stored as free text: the id selects a
      code path, and `resolveProgram` falls back to net metering for anything it does
      not recognise. Accepting a typo here would silently show someone the wrong tariff
      forever, with the settings page cheerfully displaying the value they chose.
    */
    let programId: string | null = null;
    if (body.rewardProgramId !== undefined && body.rewardProgramId !== null) {
      const raw = String(body.rewardProgramId);
      if (!PROGRAM_OPTIONS.some((option) => option.id === raw)) {
        throw new BadRequestException(`unknown rewardProgramId: ${raw}`);
      }
      programId = raw;
    }
    const includesTax =
      body.priceIncludesTax === undefined || body.priceIncludesTax === null
        ? null
        : Boolean(body.priceIncludesTax);
    /*
      Zero is a meaningful answer here — "nothing of my generation is used as it is
      made" — so this cannot go through parseOptional, which treats 0 as absent.
    */
    let selfPct: number | null = null;
    if (body.selfConsumptionPct !== undefined && body.selfConsumptionPct !== null && body.selfConsumptionPct !== '') {
      const raw = Number(body.selfConsumptionPct);
      if (!Number.isFinite(raw) || raw < 0 || raw > 100) {
        throw new BadRequestException('selfConsumptionPct must be between 0 and 100');
      }
      selfPct = raw;
    }
    /*
      Turning the estimate off is as meaningful as turning it on, so `false` has to reach
      the setter — which `!body.x` would swallow, leaving the toggle switchable one way.
    */
    const selfAuto =
      body.selfConsumptionAuto === undefined || body.selfConsumptionAuto === null
        ? null
        : Boolean(body.selfConsumptionAuto);
    if (
      price === null &&
      cost === null &&
      hstRate === null &&
      ratedKw === null &&
      programId === null &&
      includesTax === null &&
      selfPct === null &&
      selfAuto === null
    ) {
      throw new BadRequestException('Nothing to update');
    }
    await this.readings.setConfig(
      price,
      cost,
      hstRate,
      ratedKw,
      programId,
      includesTax,
      selfPct,
      selfAuto,
    );
    // Every field here feeds the savings figures, so the cached ones are now wrong.
    this.savings.invalidate();
    return this.readings.getConfig();
  }
}
