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

  /** Separate from the image: it changes only when the site moves, so it caches hard. */
  @Get('geography')
  geography(): Promise<object> {
    return this.radar.geography();
  }

  /** 204, not 404: off is the default, and an <img> on a 404 draws a broken-image icon. */
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
