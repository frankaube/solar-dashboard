import { BadRequestException, Body, Controller, Delete, Get, Post, Query } from '@nestjs/common';
import { CloudImportService, ImportSummary } from './cloud-import.service';

/** Repairing a hole in the power history, from the app. */
@Controller('readings/cloud-import')
export class CloudImportController {
  constructor(private readonly imports: CloudImportService) {}

  /** Days that already carry imported rows, so the state is visible rather than inferred. */
  @Get()
  list(): Promise<object> {
    return this.imports.imported();
  }

  /**
   * Read an export and say what it would do. Only `?commit=true` writes — this touches the
   * only copy of the measurement history, so a preview comes first.
   */
  @Post()
  async run(
    @Query('commit') commit?: string,
    @Query('date') date?: string,
    @Body() body?: Buffer | { text?: string },
  ): Promise<ImportSummary> {
    // A raw upload or a pasted string: a file saved from the vendor portal, or rows copied
    // out of it.
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : (body?.text ?? '');
    if (!text.trim()) throw new BadRequestException('Nothing to import — paste the export or choose a file.');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    try {
      return await this.imports.run(text, { fallbackDate: date, apply: commit === 'true' });
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /** Remove imported rows for one day. Only ever touches rows an import wrote. */
  @Delete()
  async undo(@Query('date') date?: string): Promise<object> {
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BadRequestException('date must be YYYY-MM-DD');
    }
    return this.imports.undo(date);
  }
}
