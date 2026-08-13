import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { WeatherService } from './weather.service';

@Controller('weather')
export class WeatherController {
  constructor(private readonly weather: WeatherService) {}

  @Get()
  getWeather(): object {
    return this.weather.getWeather();
  }

  /** Where the array is. Null until configured — the forecast stays off until then. */
  @Get('location')
  async getLocation(): Promise<object> {
    return { location: await this.weather.getLocation() };
  }

  @Put('location')
  async setLocation(@Body() body: { latitude?: number; longitude?: number }): Promise<object> {
    const { latitude, longitude } = body;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      throw new BadRequestException('latitude and longitude are required numbers');
    }
    try {
      await this.weather.setLocation(latitude, longitude);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return { ok: true };
  }
}
