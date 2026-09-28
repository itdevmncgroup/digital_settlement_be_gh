import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import type { AuthUser } from '../decorators/current-user.decorator';
import { winstonLogger } from '../logger/winston.logger';

// Nest's default behaviour for an unhandled (non-HttpException) throw is a bare
// {"statusCode":500,"message":"Internal server error"} response AND log line -
// enough to know something broke, nothing about what or where. This logs the
// full exception (name/message/stack) plus request context (method/url/query/
// body/actor) to the winston daily files on every request that errors, while
// keeping the client-facing response exactly as safe/generic as before.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttpException
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error' };

    const user = request.user as AuthUser | undefined;
    const error = exception instanceof Error ? exception : new Error(String(exception));

    winstonLogger.log(status >= 500 ? 'error' : 'warn', error.message, {
      name: error.name,
      stack: error.stack,
      statusCode: status,
      method: request.method,
      url: request.originalUrl,
      query: request.query,
      params: request.params,
      body: redactBody(request.body),
      userId: user?.userId,
      email: user?.email,
    });

    response.status(status).json(body);
  }
}

// Never write auth secrets to disk even in a debug log.
const REDACTED_KEYS = new Set(['password', 'currentPassword', 'newPassword', 'token', 'refreshToken']);
function redactBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  return Object.fromEntries(
    Object.entries(body as Record<string, unknown>).map(([key, value]) => [
      key,
      REDACTED_KEYS.has(key) ? '[REDACTED]' : value,
    ]),
  );
}
