import { Body, Controller, Get, Put, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RadarService } from './radar.service';

@Controller('radar')
export class RadarController {
  constructor(private readonly radar: RadarService) {}

  @Get()
  status(): Promise<object> {
    return this.radar.status();
  }

  @Put()
  async setEnabled(@Body() body: { enabled?: unknown }): Promise<object> {
    await this.radar.setEnabled(Boolean(body?.enabled));
    return this.radar.status();
  }

  /**
   * The geography that goes under the picture.
   *
   * Separate from the image because it changes only when the site moves, where the radar
   * changes every few minutes — and because it is the same answer for every viewer, so it
   * can be cached hard rather than re-sent with each frame.
   */
  @Get('geography')
  geography(): Promise<object> {
    return this.radar.geography();
  }

  /**
   * The picture itself.
   *
   * 204 rather than an error when there is nothing to show. Switched off is the default and
   * not a fault, and an <img> pointed at a 404 draws a broken-image icon on a page where
   * nothing is broken.
   */
  @Get('image.png')
  async image(@Res() res: Response): Promise<void> {
    const image = await this.radar.image();
    if (!image) {
      res.status(204).end();
      return;
    }
    res.setHeader('Content-Type', image.type);
    // Matches the service's own cache: asking more often returns the same picture.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(image.body);
  }
}
