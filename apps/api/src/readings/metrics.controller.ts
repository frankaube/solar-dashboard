import { Controller, Get, Header } from '@nestjs/common';
import { CollectorService } from '../collector/collector.service';
import { AlertsService } from '../alerts/alerts.service';

const MILLISECONDS_PER_SECOND = 1000;

/**
 * Prometheus text exposition (scrape /api/metrics). Hand-rolled — the metric
 * set is small and gauge-only, so a client library would be overkill.
 */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly collector: CollectorService,
    private readonly alerts: AlertsService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async getMetrics(): Promise<string> {
    const lines: string[] = [];
    const gauge = (name: string, help: string, rows: Array<[string, number]>): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const [labels, value] of rows) {
        lines.push(`${name}${labels} ${value}`);
      }
    };

    const snapshot = this.collector.getLastSnapshot();
    if (snapshot) {
      gauge('solar_dtu_power_watts', 'Total system AC power', [['', snapshot.totalPower]]);
      gauge('solar_dtu_daily_energy_wh', 'Energy produced today', [['', snapshot.dailyEnergyWh]]);
      gauge(
        'solar_snapshot_timestamp_seconds',
        'DTU timestamp of the last snapshot',
        [['', snapshot.takenAt.getTime() / MILLISECONDS_PER_SECOND]],
      );
      gauge(
        'solar_inverter_power_watts',
        'AC power per microinverter',
        snapshot.inverters.map((inv) => [`{serial="${inv.serialNumber}"}`, inv.activePower]),
      );
      gauge(
        'solar_inverter_temperature_celsius',
        'Temperature per microinverter',
        // Omit rather than export 0 for vendors that don't report temperature — a
        // fake 0 °C would skew any alerting built on this series.
        snapshot.inverters
          .filter((inv) => inv.temperature !== undefined)
          .map((inv) => [`{serial="${inv.serialNumber}"}`, inv.temperature as number]),
      );
      gauge(
        'solar_port_power_watts',
        'DC power per panel port',
        snapshot.ports.map((port) => [
          `{serial="${port.inverterSerialNumber}",port="${port.portNumber}"}`,
          port.power,
        ]),
      );
    }
    gauge('solar_open_alerts', 'Currently open health alerts', [
      ['', await this.alerts.countOpen()],
    ]);
    return `${lines.join('\n')}\n`;
  }
}
