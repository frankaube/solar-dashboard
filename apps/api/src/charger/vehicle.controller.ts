import { BadRequestException, Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { TeslamateService } from './teslamate.service';
import {
  TESLAMATE_DEFAULTS,
  TeslamateConfig,
  normalise,
  validateConfig,
} from './teslamate-config';
import { DEFAULT_RADIUS_M, HomeLocation, parseHome } from './home-location';

/**
 * Configuring the vehicle integration from the app.
 *
 * It used to be an environment variable, which meant adding a car to a running install was
 * an ssh session, a hand-written Postgres URL, a restart and a trip through the journal to
 * find out whether it worked. Four steps, each silent when wrong.
 */
@Controller('vehicle')
export class VehicleController {
  constructor(private readonly teslamate: TeslamateService) {}

  @Get('config')
  async config(): Promise<object> {
    const current = await this.teslamate.config();
    return {
      ...this.teslamate.describe(),
      // Defaults, so the form arrives filled in rather than empty. TeslaMate's own compose
      // file uses these and most installs never change them.
      config: current?.config ?? TESLAMATE_DEFAULTS,
      passwordSet: current?.passwordSet ?? false,
    };
  }

  /**
   * Try a connection without saving it.
   *
   * 200 with ok:false for a database that refuses — the request was well formed, and
   * "password authentication failed" is the useful answer rather than an exception the
   * client has to unwrap.
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
      Tested before saved, always.

      Saving a config that does not work leaves the panel reporting a connection while
      every query fails quietly in the background — the state this endpoint exists to
      prevent. A refusal here is a 200 with ok:false, because the request was fine.
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
   * Where home is.
   *
   * The Car page claimed the car was "in the garage" because nothing here existed — it was
   * the else branch of a charger check. Knowing which coordinates are home is the only way
   * to say it and mean it. Returns the car's current position alongside, so the form can be
   * filled from the driveway rather than from a map in another tab.
   */
  @Get('home')
  async home(): Promise<object> {
    const [home, carPosition] = await Promise.all([
      this.teslamate.home(),
      this.teslamate.currentPosition(),
    ]);
    return { home, carPosition, defaultRadiusM: DEFAULT_RADIUS_M };
  }

  @Put('home')
  async saveHome(@Body() body: Partial<HomeLocation>): Promise<object> {
    const { home, problems } = parseHome(body ?? {});
    if (!home) throw new BadRequestException(problems[0]?.message ?? 'Invalid location');
    await this.teslamate.saveHome(home);
    return { ok: true, home };
  }

  @Delete('home')
  async clearHome(): Promise<{ ok: true }> {
    await this.teslamate.clearHome();
    return { ok: true };
  }

  /**
   * Keep the saved password when the form did not send one.
   *
   * The config endpoint returns `passwordSet` rather than the password itself, so the field
   * arrives blank on every load. Treating blank as "clear it" would mean editing the port
   * silently wipes the credentials.
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
