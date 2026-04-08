import Fastify from 'fastify';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { env } from '@config/env';
import { AppError } from '@utils/errors';

// Plugins
import sensiblePlugin from '@plugins/sensible';
import helmetPlugin from '@plugins/helmet';
import corsPlugin from '@plugins/cors';
import redisPlugin from '@plugins/redis';
import rateLimitPlugin from '@plugins/rate-limit';
import postgresPlugin from '@plugins/postgres';
import jwtPlugin from '@plugins/jwt';
import awsPlugin from '@plugins/aws';

// Routes
import healthRoute from '@routes/health';
import apiRoutes from '@routes/index';
import internalCameraRoutes from '@routes/internal/cameras/index';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
            },
          }
        : {}),
      redact: {
        paths: ['req.headers.authorization', 'req.body.password', 'req.body.refreshToken'],
        censor: '[REDACTED]',
      },
    },
    trustProxy: true,
  });

  // Plugin registration order matters
  void app.register(sensiblePlugin);
  void app.register(helmetPlugin);
  void app.register(corsPlugin);
  void app.register(redisPlugin);
  void app.register(rateLimitPlugin);
  void app.register(postgresPlugin);
  void app.register(jwtPlugin);
  void app.register(awsPlugin);

  // Routes
  void app.register(healthRoute);
  void app.register(apiRoutes, { prefix: '/api/v1' });
  void app.register(internalCameraRoutes, { prefix: '/internal/cameras' });

  // Global error handler — { error: { code, message } } shape
  app.setErrorHandler<FastifyError>((err, _request, reply) => {
    app.log.error({ err }, 'Unhandled error');

    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({
        error: { code: err.code, message: err.message },
      });
    }

    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: err.errors[0]?.message ?? 'Validation failed' },
      });
    }

    // Fastify validation errors
    if (err.validation) {
      return reply.code(400).send({
        error: { code: 'VALIDATION_ERROR', message: err.message },
      });
    }

    // Rate limit errors
    if (err.statusCode === 429) {
      return reply.code(429).send({
        error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests' },
      });
    }

    // Never leak internals
    return reply.code(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  return app;
}
