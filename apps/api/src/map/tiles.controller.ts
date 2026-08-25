import { Body, Controller, Get, Param, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { TilesService } from './tiles.service';

@Controller('map')
export class TilesController {
  constructor(private readonly tiles: TilesService) {}

  @Get('status')
  async status(): Promise<{ enabled: boolean }> {
    return { enabled: await this.tiles.isEnabled() };
  }

  @Put('status')
  async setStatus(@Body() body: { enabled?: boolean }): Promise<{ enabled: boolean }> {
    await this.tiles.setEnabled(body?.enabled === true);
    return { enabled: await this.tiles.isEnabled() };
  }

  /**
   * 204 rather than 404 when the map is off or a tile is unavailable: an <img> pointed at a
   * 404 draws a broken-image icon. The radar controller answers the same way.
   */
  @Get('tile/:z/:x/:y.png')
  async tile(
    @Param('z') z: string,
    @Param('x') x: string,
    @Param('y') y: string,
    @Res() res: Response,
  ): Promise<void> {
    const body = await this.tiles.tile(Number(z), Number(x), Number(y));
    if (!body) {
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', 'image/png');
    // Streets do not move.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(body);
  }
}
