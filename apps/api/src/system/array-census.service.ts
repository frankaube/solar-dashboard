import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { INVERTER_COUNT_SETTING_KEY, PV_COUNT_SETTING_KEY } from '../common/settings-keys';
import { Census, CensusFinding, buildCensus } from './array-census';

/** What the owner's paperwork says. Nothing on the wire can tell us this. */
export const PANEL_COUNT_SETTING_KEY = 'contractPanelCount';
export const PANEL_WATTS_SETTING_KEY = 'contractPanelWatts';
const RATED_KW_SETTING_KEY = 'systemRatedKw';

/**
 * ONLY the peaks are cached: scanning every port reading for a maximum is not a
 * five-minute-poll query. Everything else is read live, so nothing needs invalidating.
 */
const PEAK_CACHE_MS = 60 * 60_000;

@Injectable()
export class ArrayCensusService {
  private readonly logger = new Logger(ArrayCensusService.name);
  private peaks: { at: number; systemW: number | null; panelW: number | null } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private async setting(key: string): Promise<string | null> {
    const row = await this.prisma.setting.findUnique({ where: { key } });
    return row?.value ?? null;
  }

  private async number(key: string): Promise<number | null> {
    const raw = await this.setting(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  /** All-time maxima, recomputed at most hourly. The only expensive part of a census. */
  private async observedPeaks(): Promise<{ systemW: number | null; panelW: number | null }> {
    if (this.peaks && Date.now() - this.peaks.at < PEAK_CACHE_MS) return this.peaks;
    const [system, panel] = await Promise.all([
      this.prisma.dtuReading.aggregate({ _max: { totalPower: true } }),
      this.prisma.portReading.aggregate({ _max: { power: true } }),
    ]);
    this.peaks = {
      at: Date.now(),
      systemW: system._max.totalPower ?? null,
      panelW: panel._max.power ?? null,
    };
    return this.peaks;
  }

  async get(): Promise<Census> {
    const [configuredRatedKw, registeredPanels, expectedInverters, panels, wattsPerPanel] =
      await Promise.all([
        this.number(RATED_KW_SETTING_KEY),
        this.number(PV_COUNT_SETTING_KEY),
        this.number(INVERTER_COUNT_SETTING_KEY),
        this.number(PANEL_COUNT_SETTING_KEY),
        this.number(PANEL_WATTS_SETTING_KEY),
      ]);

    const inverters = await this.prisma.microinverter.findMany({
      select: { id: true, _count: { select: { ports: true } } },
    });
    const portsPerInverter = inverters.map((inv) => inv._count.ports).filter((n) => n > 0);
    const reportingPanels = portsPerInverter.reduce((sum, n) => sum + n, 0);

    const peaks = await this.observedPeaks();
    const days = await this.prisma.dtuReading.findMany({
      distinct: ['localDate'],
      select: { localDate: true },
    });

    return buildCensus({
      configuredRatedKw,
      registeredPanels,
      reportingPanels,
      expectedInverters,
      reportingInverters: portsPerInverter.length,
      portsPerInverter,
      contract: panels && wattsPerPanel ? { panels, wattsPerPanel } : null,
      observedPeakW: peaks.systemW,
      observedPeakPerPanelW: peaks.panelW,
      daysObserved: days.length,
    });
  }

  /**
   * Only the serious findings: "some panels send no detail" holds every minute of every
   * day and would be a permanent unread notification.
   */
  async alertCandidates(): Promise<
    Array<{ type: 'array_mismatch'; severity: 'serious'; subjectKey: string; message: string }>
  > {
    try {
      const census = await this.get();
      return census.findings
        .filter((finding: CensusFinding) => finding.severity === 'serious')
        .map((finding) => ({
          type: 'array_mismatch' as const,
          severity: 'serious' as const,
          subjectKey: finding.id,
          message: finding.headline,
        }));
    } catch (error) {
      // A census that cannot be built must never stop the rest of the alert engine.
      this.logger.warn(`Census failed: ${(error as Error).message}`);
      return [];
    }
  }
}
