import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { NestWinstonLogger } from './common/logger/nest-logger.service';
import { winstonLogger } from './common/logger/winston.logger';
import { resolveDatabaseUrl } from './config/resolve-database-url';

// Must run before NestFactory.create - that's when PrismaService (extending
// PrismaClient) is instantiated and reads process.env.DATABASE_URL.
resolveDatabaseUrl();

// AllExceptionsFilter only ever sees errors thrown inside a request's Nest
// lifecycle - it can't catch one that escapes to the process itself (a stray
// unawaited rejection, a callback outside any request context, ...). Today
// that class of crash is invisible: the process dies mid-response, the
// frontend's dev proxy sees a bare ECONNRESET, and nothing is ever written to
// logs/error-*.log to say why. These handlers make sure the real reason gets
// logged before Node's default behavior takes the process down (uncaught
// exceptions are still fatal by design - this only adds a paper trail).
process.on('uncaughtException', (err) => {
  winstonLogger.error(`uncaughtException: ${err.message}`, { stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  winstonLogger.error(`unhandledRejection: ${err.message}`, { stack: err.stack });
});

// ExternalSyncService.pushSettlement bundles every photo/invoice file of a
// settlement's expenses (each up to MAX_UPLOAD_SIZE_BYTES, base64-encoded) into
// one JSON POST to /external/settlements - easily tens of MB. Express's
// body-parser default (100kb) rejects that outright with PayloadTooLargeError,
// so the global json/urlencoded limits are raised well above the per-file cap.
const EXTERNAL_PUSH_BODY_LIMIT = '50mb';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: new NestWinstonLogger(), bodyParser: false });

  app.use(json({ limit: EXTERNAL_PUSH_BODY_LIMIT }));
  app.use(urlencoded({ extended: true, limit: EXTERNAL_PUSH_BODY_LIMIT }));
  app.use(helmet());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors();
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Node closes an idle keep-alive connection after 5s by default. The Next.js
  // dev rewrite proxy (and Node's global agent, keepAlive since Node 19) pools
  // and reuses those connections, so a request sent in the same instant the
  // server sends its FIN dies with ECONNRESET - intermittent 500s on the
  // frontend even though nothing here actually failed. Keeping connections
  // alive far longer than the proxy ever idles shrinks that race window.
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000; // must stay above keepAliveTimeout

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`API listening on http://localhost:${port}/api/v1`);
}

bootstrap();
