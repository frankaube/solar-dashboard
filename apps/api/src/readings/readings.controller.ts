import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { buildInfo } from '../common/build-info';
import { CollectorService } from '../collector/collector.service';
import { AlertsService } from '../alerts/alerts.service';
import { AnalyticsService } from './analytics.service';
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
    if (
      price === null &&
      cost === null &&
      hstRate === null &&
      ratedKw === null &&
      programId === null &&
      includesTax === null &&
      selfPct === null
    ) {
      throw new BadRequestException('Nothing to update');
    }
    await this.readings.setConfig(price, cost, hstRate, ratedKw, programId, includesTax, selfPct);
    // Every field here feeds the savings figures, so the cached ones are now wrong.
    this.savings.invalidate();
    return this.readings.getConfig();
  }
}
