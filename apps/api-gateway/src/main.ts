import express, { Express } from 'express';
import cors, { CorsOptions } from 'cors';
import helmet from 'helmet';
import path from 'path';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
dotenv.config();

import { errorHandler, rateLimit } from '@shared/config';
import { httpLogger } from '@shared/logger';
import { healthCheck, selfHealth } from './controllers/health-controller';
import docsRoutes from './routes/docs-route';
import apiRoutes from './routes/api-route';
import { awsRouter } from './routes/aws-route';
import { jwtMiddleware } from './middlewares/jwt-middleware';

const host = process.env.HOST ? process.env.HOST : 'localhost';
const port = process.env.API_GATEWAY_PORT ? Number(process.env.API_GATEWAY_PORT) : 3000;

/** 로컬 개발용 origin. 운영은 `CORS_ORIGINS=https://a.com,https://b.com`(쉼표 구분)으로 지정한다. */
const defaultOrigins = [
  'http://localhost:5000',
  'http://localhost:5001',
  'http://localhost:5002',
  'http://localhost:5003',
  'http://localhost:5004',
  'http://localhost:5005',
  'https://www.fundmate.com',
];

export const getAllowedOrigins = (): string[] => {
  const fromEnv = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const origins = fromEnv.length > 0 ? fromEnv : defaultOrigins;
  return process.env.FRONTEND_URL ? [...new Set([...origins, new URL(process.env.FRONTEND_URL).origin])] : origins;
};

const perMinute = (max: number, message?: string) => rateLimit({ windowMs: 60 * 1000, max, message });

export const createApp = (): Express => {
  const app = express();

  // 앞단 프록시(nginx, 로드 밸런서) 뒤에서 실제 클라이언트 IP(rate limit 기준)를 쓰기 위해 필요하다.
  app.set('trust proxy', process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal');

  const allowedOrigins = getAllowedOrigins();
  const corsOptions: CorsOptions = {
    // Origin 헤더가 없는 요청(서버 간 호출, curl)은 브라우저 CORS 대상이 아니므로 통과시킨다.
    // 허용되지 않은 origin은 에러가 아니라 CORS 헤더 없이 응답한다.
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    maxAge: 600,
  };

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  // 상태 확인은 제한/로깅 대상이 아니다.
  app.get('/health', selfHealth);
  app.get('/health-checks', healthCheck);

  app.use(httpLogger);
  app.use(perMinute(Number(process.env.RATE_LIMIT_PER_MIN) || 300));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  if (process.env.DOCS_ENABLED !== 'false') {
    app.use('/docs', docsRoutes);
    app.use('/assets', express.static(path.join(__dirname, 'src/assets')));
  }

  // 남용되기 쉬운 경로는 더 엄격하게 제한한다. (로그인 무차별 대입, 메일 발송, 유료 LLM, 외부 API 쿼터)
  app.use(['/auth', '/oauth'], perMinute(30));
  app.use('/ai', perMinute(10));
  app.use('/datas', perMinute(60));

  // 업로드는 로그인한 사용자만
  app.use('/upload', perMinute(30), jwtMiddleware(true), awsRouter());
  app.use('/', apiRoutes);

  app.use(errorHandler);
  return app;
};

if (process.env.NODE_ENV !== 'test') {
  createApp().listen(port, host, () => {
    console.log(`[ ready ] http://${host}:${port}`);
  });
}
