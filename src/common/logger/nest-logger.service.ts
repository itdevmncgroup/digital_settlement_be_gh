import { LoggerService } from '@nestjs/common';
import { winstonLogger } from './winston.logger';

// Swapped in via app.useLogger() in main.ts so every Logger(context) call
// Nest itself makes (route mapping, module init, ...) and every
// `new Logger(X)` elsewhere in the app land in the same daily log files as
// AllExceptionsFilter instead of only ever going to stdout.
export class NestWinstonLogger implements LoggerService {
  log(message: unknown, context?: string) {
    winstonLogger.info(this.format(message), { context });
  }

  error(message: unknown, trace?: string, context?: string) {
    winstonLogger.error(this.format(message), { trace, context });
  }

  warn(message: unknown, context?: string) {
    winstonLogger.warn(this.format(message), { context });
  }

  debug(message: unknown, context?: string) {
    winstonLogger.debug(this.format(message), { context });
  }

  verbose(message: unknown, context?: string) {
    winstonLogger.verbose(this.format(message), { context });
  }

  private format(message: unknown): string {
    return typeof message === 'string' ? message : JSON.stringify(message);
  }
}
