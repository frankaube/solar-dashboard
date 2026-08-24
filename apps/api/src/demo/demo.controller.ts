import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { DemoService } from './demo.service';
import { fixtureCatalogue } from './fixtures';
import { compareHouses, valueHouse } from './house-model';
import {
  BATTERY_OPTIONS,
  EV_OPTIONS,
  HouseSpec,
  PANEL_OPTIONS,
  PRESETS,
} from './house-spec';

/** Longest `?house=` we will even attempt to decode. A real spec is ~600 chars. */
const MAX_SPEC_CHARS = 4096;

/**
 * Decode `?house=<base64url JSON>` into a spec, or fall back to the default house.
 *
 * The spec rides on the request rather than living in server state, so one hosted
 * demo can serve many visitors each exploring a different house without any of them
 * disturbing the others.
 *
 * That also makes this a trust boundary: on a public instance the value is whatever a
 * stranger typed. Anything malformed quietly becomes the default house — a demo is
 * not worth a 500, and refusing to explain the difference between "you sent nothing"
 * and "you sent nonsense" gives away nothing useful either. The numeric clamps matter
 * more than they look: `panelCount` drives a per-day loop and latitude feeds acos(),
 * so an absurd value is a denial of service rather than a silly-looking chart.
 */
function house(raw?: string): HouseSpec | undefined {
  if (!raw || raw.length > MAX_SPEC_CHARS) return undefined;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as HouseSpec;
    if (!parsed || typeof parsed !== 'object' || !parsed.location || !parsed.tariff) {
      return undefined;
    }
    const clamp = (n: unknown, lo: number, hi: number, fallback: number): number => {
      const v = Number(n);
      return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    };
    return {
      ...parsed,
      location: {
        label: String(parsed.location.label ?? 'Custom'),
        latitude: clamp(parsed.location.latitude, -85, 85, 45),
        timezone: String(parsed.location.timezone ?? 'UTC'),
      },
      solar: parsed.solar
        ? {
            panelCount: Math.round(clamp(parsed.solar.panelCount, 0, 1000, 0)),
            panelWatts: clamp(parsed.solar.panelWatts, 50, 1000, 400),
          }
        : null,
      battery: parsed.battery
        ? {
            label: String(parsed.battery.label ?? 'Battery'),
            capacityKwh: clamp(parsed.battery.capacityKwh, 0, 1000, 0),
            usableFraction: clamp(parsed.battery.usableFraction, 0, 1, 0.9),
          }
        : null,
      tariff: {
        retailPerKwh: clamp(parsed.tariff.retailPerKwh, 0.001, 5, 0.16),
        taxRate: clamp(parsed.tariff.taxRate, 0, 0.99, 0.15),
        programId: parsed.tariff.programId === 'feed-in-tariff' ? 'feed-in-tariff' : 'net-metering',
      },
    };
  } catch {
    return undefined;
  }
}

/**
 * Mirrors the read endpoints the UI uses, under /api/demo. The frontend swaps
 * its base to /api/demo when demo mode is on — so the whole app populates with
 * generated data without ever touching the real database.
 */
@Controller('demo')
export class DemoController {
  constructor(private readonly demo: DemoService) {}

  @Get('summary')
  summary(@Query("house") q?: string): object {
    return this.demo.for(house(q)).summary();
  }

  @Get('live')
  live(@Query("house") q?: string): object {
    return this.demo.for(house(q)).live();
  }

  @Get('history/power')
  power(@Query('hours') hours?: string, @Query("house") q?: string): object {
    return this.demo.for(house(q)).powerHistory(Number(hours ?? 24));
  }

  @Get('history/energy')
  energy(@Query('days') days?: string, @Query("house") q?: string): object {
    return this.demo.for(house(q)).energyHistory(Number(days ?? 30));
  }

  @Get('history/port/:id')
  port(@Query("house") q?: string): object {
    return this.demo.for(house(q)).powerHistory(24);
  }

  @Get('history/weather')
  weatherHistory(@Query('hours') hours?: string, @Query("house") q?: string): object {
    const points = this.demo.for(house(q)).powerHistory(Number(hours ?? 24)) as Array<{ t: string; powerW: number }>;
    return points.map((p) => ({ t: p.t, irradiance: Math.round(p.powerW / 24), cloudCover: 20 }));
  }

  @Get('stats')
  stats(@Query("house") q?: string): object {
    return this.demo.for(house(q)).stats();
  }

  @Get('records')
  records(@Query("house") q?: string): object {
    return this.demo.for(house(q)).records();
  }

  @Get('savings')
  savings(@Query("house") q?: string): object {
    return this.demo.for(house(q)).savings();
  }

  @Get('analytics/production')
  analytics(@Query('hours') hours?: string, @Query("house") q?: string): object {
    return this.demo.for(house(q)).analyticsProduction(Number(hours ?? 24));
  }

  @Get('analytics/temp-power')
  tempPower(@Query("house") q?: string): object[] {
    return this.demo.for(house(q)).tempPower();
  }

  @Get('analytics/voltage-power')
  voltagePower(@Query("house") q?: string): object[] {
    return this.demo.for(house(q)).voltagePower();
  }

  @Get('analytics/panels')
  panelInsights(@Query("house") q?: string): object[] {
    return this.demo.for(house(q)).panelInsights();
  }

  @Get('weather')
  weather(@Query("house") q?: string): object {
    return this.demo.for(house(q)).weather();
  }

  @Get('config')
  config(@Query("house") q?: string): object {
    return this.demo.for(house(q)).config();
  }

  @Get('onboarding/status')
  onboarding(@Query("house") q?: string): object {
    return this.demo.for(house(q)).onboarding();
  }

  @Get('notifications')
  notifications(): object {
    return { webhook: null };
  }

  @Get('alerts')
  alerts(@Query("house") q?: string): object {
    return this.demo.for(house(q)).alerts();
  }

  @Get('panels')
  panels(@Query("house") q?: string): object[] {
    return this.demo.for(house(q)).panels();
  }

  @Get('devices')
  devices(@Query("house") q?: string): object[] {
    return this.demo.for(house(q)).devices();
  }

  @Get('devices/usage')
  usage(@Query("house") q?: string): object[] {
    return this.demo.for(house(q)).deviceUsage();
  }

  @Get('charger')
  charger(@Query("house") q?: string): object {
    return this.demo.for(house(q)).charger();
  }

  @Get('charger/sessions')
  sessions(@Query('days') days?: string, @Query("house") q?: string): object {
    return this.demo.for(house(q)).chargerSessions(Number(days ?? 30));
  }

  @Get('charger/vehicle')
  vehicle(@Query("house") q?: string): object {
    return this.demo.for(house(q)).vehicleDetails();
  }

  /** The fixture picker: which devices demo mode can stand in for. */
  @Get('fixtures')
  fixtures(): object {
    return fixtureCatalogue();
  }

  /**
   * `?fixture=<id>` swaps the generated battery for a recorded vendor payload run
   * through the production parser. Without it, the original generated battery.
   */
  @Get('battery')
  battery(@Query('fixture') fixture?: string, @Query("house") q?: string): object {
    if (fixture) {
      const state = this.demo.for(house(q)).batteryFixture(fixture);
      if (!state) throw new NotFoundException(`unknown fixture: ${fixture}`);
      return state;
    }
    return this.demo.for(house(q)).battery();
  }

  @Get('setup/devices')
  setupDevices(): object {
    return { dtuHost: 'demo', chargerHost: 'demo', suggestedSubnet: '192.168.1', vendors: [] };
  }

  /** What the builder can offer: presets and the equipment catalogue. */
  @Get('house/options')
  houseOptions(): object {
    return {
      presets: PRESETS,
      panels: PANEL_OPTIONS,
      batteries: BATTERY_OPTIONS,
      evs: EV_OPTIONS,
      heating: ['none', 'baseboard', 'heat-pump'],
      programs: [
        { id: 'net-metering', label: 'Net metering (1:1 credit)' },
        { id: 'feed-in-tariff', label: 'Feed-in tariff (paid for export)' },
      ],
    };
  }

  /**
   * Value one house, or two.
   *
   * POST rather than GET: a spec is a nested object, and encoding it into a query
   * string would be a lot of machinery for a call that changes nothing on the server.
   * `before` is optional — with it you get the comparison, which is the point.
   */
  @Post('house/value')
  houseValue(
    @Body() body: { spec?: HouseSpec; before?: HouseSpec; capitalCost?: number },
  ): object {
    if (!body?.spec) throw new BadRequestException('spec is required');
    if (body.before) {
      return compareHouses(body.before, body.spec, Number(body.capitalCost ?? 0));
    }
    return valueHouse(body.spec);
  }
}
