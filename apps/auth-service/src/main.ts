import express from 'express';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { AppDataSource } from './data-source';
import { serviceConfig, headerToLocals, errorHandler } from '@shared/config';
import { httpLogger } from '@shared/logger';
import authRouter from './routes/auth';
import oauthRouter from './routes/oauth';
import { assertRequiredEnv } from './modules/tokens';
dotenv.config();

const { port, host, url } = serviceConfig['auth-service'];

assertRequiredEnv();

const app = express();
app.use(httpLogger);
app.use(express.json({ limit: '10kb' }));
app.use(headerToLocals);

app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'auth-service', timestamp: new Date().toISOString() })
);

app.use(cookieParser());
app.use('/auth', authRouter);
app.use('/oauth', oauthRouter);
app.use(errorHandler);

AppDataSource.initialize()
  .then(() => {
    console.log('데이터 베이스 연결 성공');
    app.listen(port, host, () => {
      console.log(`[ ready ] ${url}`);
    });
  })
  .catch((error) => {
    console.error('데이터 베이스 연결 실패:', error?.message ?? error);
    process.exit(1);
  });
