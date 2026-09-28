import * as path from 'path';
import * as winston from 'winston';
import 'winston-daily-rotate-file';

// One file per calendar day under logs/ (already covered by the repo's *.log
// .gitignore entry) - kept 30 days, plus a separate errors-only stream so a
// 500 doesn't get lost scrolling through routine request noise.
const logsDir = path.join(process.cwd(), 'logs');

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

function dailyRotateFile(filenamePrefix: string, level?: string) {
  return new winston.transports.DailyRotateFile({
    dirname: logsDir,
    filename: `${filenamePrefix}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    maxFiles: '30d',
    level,
  });
}

export const winstonLogger = winston.createLogger({
  level: 'info',
  format: fileFormat,
  transports: [
    dailyRotateFile('app'),
    dailyRotateFile('error', 'error'),
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
    }),
  ],
});
