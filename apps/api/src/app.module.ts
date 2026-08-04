import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { PrismaModule } from './prisma/prisma.module';
import { AlertsModule } from './alerts/alerts.module';
import { BatteryModule } from './battery/battery.module';
import { BackupModule } from './backup/backup.module';
import { SystemModule } from './system/system.module';
import { EvccModule } from './evcc/evcc.module';
import { OcppModule } from './ocpp/ocpp.module';
import { ChargerModule } from './charger/charger.module';
import { CollectorModule } from './collector/collector.module';
import { DemoModule } from './demo/demo.module';
import { DevicesModule } from './devices/devices.module';
import { ReadingsModule } from './readings/readings.module';
import { SetupModule } from './setup/setup.module';
import { UpdatesModule } from './updates/updates.module';
import { WeatherModule } from './weather/weather.module';

// In production the API serves the built web app itself (Lite-build foundation —
// no separate web server). In dev the folder doesn't exist and Vite serves the UI.
import { isPackaged, resourcePath } from './common/lite';

const PUBLIC_DIR = isPackaged ? resourcePath('public') : join(__dirname, '..', 'public');

@Module({
  imports: [
    ...(existsSync(PUBLIC_DIR)
      ? [
          ServeStaticModule.forRoot({
            rootPath: PUBLIC_DIR,
            exclude: ['/api/{*path}'],
          }),
        ]
      : []),
    PrismaModule,
    AlertsModule,
    BatteryModule,
    BackupModule,
    SystemModule,
    EvccModule,
    OcppModule,
    ChargerModule,
    CollectorModule,
    DemoModule,
    DevicesModule,
    ReadingsModule,
    SetupModule,
    UpdatesModule,
    WeatherModule,
  ],
})
export class AppModule {}
