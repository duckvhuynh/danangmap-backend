import 'reflect-metadata';
import { Logger, ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from '../../../src/app.module';
import { ProblemDetailsFilter } from '../../../src/common/http/problem-details.filter';
import { SuccessEnvelopeInterceptor } from '../../../src/common/http/success-envelope.interceptor';
import { frontendOrigins } from '../../../src/config/environment';
import { AppException } from '../../../src/common/http/app.exception';

export async function createApplication() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const allowedOrigins = frontendOrigins(config.getOrThrow<string>('app.frontendOrigins'));

  app.enableShutdownHooks();
  app.setGlobalPrefix('api', { exclude: ['health/live', 'health/ready'] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.use(cookieParser());
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.enableCors({
    credentials: true,
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      try {
        if (!origin || allowedOrigins.includes(new URL(origin).origin)) callback(null, true);
        else callback(new AppException(403, 'CSRF_INVALID', 'Nguồn yêu cầu không hợp lệ.'));
      } catch {
        callback(new AppException(403, 'CSRF_INVALID', 'Nguồn yêu cầu không hợp lệ.'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'X-Request-Id',
      'X-CSRF-Token',
      'If-Match',
      'If-None-Match',
      'Idempotency-Key',
    ],
    exposedHeaders: ['X-Request-Id', 'ETag', 'Retry-After'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
      stopAtFirstError: false,
    }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter());
  app.useGlobalInterceptors(new SuccessEnvelopeInterceptor(app.get(Reflector)));

  const swagger = new DocumentBuilder()
    .setTitle('DanangMap API')
    .setDescription('DanangMap v2 spatial CMS contract')
    .setVersion(config.getOrThrow<string>('app.version'))
    .addCookieAuth('__Host-danangmap_session', { type: 'apiKey', in: 'cookie' }, 'adminSession')
    .addCookieAuth('__Host-danangmap_preauth', { type: 'apiKey', in: 'cookie' }, 'preauthSession')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-CSRF-Token' }, 'csrf')
    .build();
  const document = SwaggerModule.createDocument(app, swagger);
  SwaggerModule.setup('api/docs', app, document, { jsonDocumentUrl: 'api/openapi.json' });

  return app;
}

async function bootstrap(): Promise<void> {
  const app = await createApplication();
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('app.port');
  await app.listen(port, '0.0.0.0');
  Logger.log(`DanangMap API listening on ${port}`, 'Bootstrap');
}

if (require.main === module) {
  void bootstrap();
}
