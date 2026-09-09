import { BadRequestException, Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { TeslamateService } from './teslamate.service';
import {
  TESLAMATE_DEFAULTS,
  TeslamateConfig,
  normalise,
  validateConfig,
} from './teslamate-config';
import { DEFAULT_RADIUS_M, HomeLocation, parseHome, parseRadius } from './home-location';
import { FuelPriceService } from './fuel-price.service';
import { FUEL_GEOGRAPHIES, isKnownGeography } from './statcan';

/**
 * Configuring the vehicle integration from the app, rather than through an environment
 * variable that needs a restart to change.
 */
@Controller('vehicle')
export class VehicleController {
  constructor(
    private readonly teslamate: TeslamateService,
    private readonly fuelPrices: FuelPriceService,
  ) {}

  @Get('config')
  async config(): Promise<object> {
    const current = await this.teslamate.config();
    return {
      ...this.teslamate.describe(),
      // Defaults, so the form arrives filled in: TeslaMate's own compose file uses these.
      config: current?.config ?? TESLAMATE_DEFAULTS,
      passwordSet: current?.passwordSet ?? false,
    };
  }

  /**
   * Try a connection without saving it. 200 with ok:false for a database that refuses: the
   * request was well formed, and the driver's message is the useful answer.
   */
  @Post('test')
  async test(@Body() body: Partial<TeslamateConfig>): Promise<object> {
    const config = normalise(body ?? {});
    const problems = validateConfig(config);
    if (problems.length > 0) return { ok: false, message: problems[0].message, problems };
    return this.teslamate.test(await this.withStoredPassword(config, body));
  }

  @Put('config')
  async save(@Body() body: Partial<TeslamateConfig>): Promise<object> {
    const config = normalise(body ?? {});
    const problems = validateConfig(config);
    if (problems.length > 0) throw new BadRequestException(problems[0].message);

    const resolved = await this.withStoredPassword(config, body);
    /*
      Tested before saved, always: a saved config that does not work leaves the panel
      reporting a connection while every query fails quietly. A refusal here is a 200 with
      ok:false, because the request was fine.
    */
    const result = await this.teslamate.test(resolved);
    if (!result.ok) return { ok: false, message: result.message, saved: false };
    await this.teslamate.save(resolved);
    return { ok: true, message: result.message, car: result.car, saved: true };
  }

  @Delete('config')
  async disconnect(): Promise<{ ok: true }> {
    await this.teslamate.disconnect();
    return { ok: true };
  }

  /**
   * Where home is. Returns the car's current position alongside, so the form can be filled
   * from the driveway rather than from a map in another tab.
   */
  @Get('track')
  /* No parameters: the track is whichever drive is current, or the last one. */
  getTrack(): object {
    return this.teslamate.getTrack().then((track) => ({ track }));
  }

  @Get('home')
  async home(): Promise<object> {
    const [{ home, mode, site }, carPosition] = await Promise.all([
      this.teslamate.homeState(),
      this.teslamate.currentPosition(),
    ]);
    // `site` goes out alongside so the form can show what following it would mean.
    return { home, mode, site, carPosition, defaultRadiusM: DEFAULT_RADIUS_M };
  }

  /**
   * Save home, either as its own place or as a pointer at the site's. The two modes take
   * different bodies on purpose: coordinates in a site-mode payload could disagree with it.
   */
  @Put('home')
  async saveHome(@Body() body: Partial<HomeLocation> & { mode?: string }): Promise<object> {
    if (body?.mode === 'site') {
      const { radiusM, problems } = parseRadius(body.radiusM);
      if (problems.length > 0) throw new BadRequestException(problems[0].message);
      await this.teslamate.followSite(radiusM);
      const { home, mode, site } = await this.teslamate.homeState();
      return { ok: true, home, mode, site };
    }
    const { home, problems } = parseHome(body ?? {});
    if (!home) throw new BadRequestException(problems[0]?.message ?? 'Invalid location');
    await this.teslamate.saveHome(home);
    return { ok: true, home, mode: 'manual' };
  }

  /**
   * The gasoline comparison's two assumptions, and where its prices come from.
   */
  @Get('fuel')
  async fuel(): Promise<object> {
    const [status, litres] = await Promise.all([
      this.fuelPrices.status(),
      this.fuelPrices.litresPer100Km(),
    ]);
    return {
      geographies: FUEL_GEOGRAPHIES,
      litresPer100Km: litres,
      ...status,
      source: 'Statistics Canada, table 18-10-0001 — monthly average retail prices',
    };
  }

  @Put('fuel')
  async saveFuel(
    @Body() body: { geography?: unknown; litresPer100Km?: unknown },
  ): Promise<object> {
    if (body.geography !== undefined && body.geography !== null) {
      const geography = String(body.geography);
      if (!isKnownGeography(geography)) {
        throw new BadRequestException('unknown geography — pick one of the listed places');
      }
      await this.fuelPrices.setGeography(geography);
    }
    if (body.litresPer100Km !== undefined && body.litresPer100Km !== null) {
      const litres = Number(body.litresPer100Km);
      // Bounded at both ends: under 1 L/100 km is not a petrol car, over 40 is not one
      // anyone compares a saloon against.
      if (!Number.isFinite(litres) || litres < 1 || litres > 40) {
        throw new BadRequestException('litresPer100Km must be between 1 and 40');
      }
      await this.fuelPrices.setLitresPer100Km(litres);
    }
    // Fetch now on a change of place, rather than leaving the page empty until tomorrow.
    const written = await this.fuelPrices.refresh();
    return { ok: true, monthsStored: written, ...(await this.fuelPrices.status()) };
  }

  @Delete('home')
  async clearHome(): Promise<{ ok: true }> {
    await this.teslamate.clearHome();
    return { ok: true };
  }

  /**
   * Keep the saved password when the form did not send one. The config endpoint returns
   * `passwordSet` rather than the password, so the field arrives blank on every load and
   * treating blank as "clear it" would wipe credentials on a port edit.
   */
  private async withStoredPassword(
    config: TeslamateConfig,
    body: Partial<TeslamateConfig> | undefined,
  ): Promise<TeslamateConfig> {
    if (typeof body?.password === 'string' && body.password.length > 0) return config;
    const current = await this.teslamate.config();
    if (!current?.passwordSet) return config;
    const stored = await this.teslamate.storedPassword();
    return stored === null ? config : { ...config, password: stored };
  }
}
