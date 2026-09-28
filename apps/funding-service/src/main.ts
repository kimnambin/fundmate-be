import 'reflect-metadata';
import express from 'express';
import dotenv from 'dotenv';
import FundingRouter from './routes/FundingRouter';
import OptionRouter from './routes/OptionRouter';
import MainRouter from './routes/MainRouter';
import ProfileRouter from './routes/ProfileRouter';
import { AppDataSource } from './data-source';
import { serviceConfig, headerToLocals, errorHandler } from '@shared/config';
import { httpLogger } from '@shared/logger';

dotenv.config();

const { port, host, url } = serviceConfig['funding-service'];

const app = express();
app.use(httpLogger);
// 프로젝트 설명이 길 수 있어 다른 서비스보다 여유를 둔다.
app.use(express.json({ limit: '200kb' }));
app.use(headerToLocals);

app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'funding-service', timestamp: new Date().toISOString() })
);

app.use('/projects', FundingRouter);
app.use('/options', OptionRouter);
app.use('/api/projects', MainRouter);
app.use('/profiles', ProfileRouter);
app.use(errorHandler);

AppDataSource.initialize()
  .then(() => {
    console.log('데이터베이스 연결 성공');
    app.listen(port, host, () => {
      console.log(`[ ready ] ${url}`);
    });
  })
  .catch((error) => {
    console.error('데이터베이스 연결 실패:', error?.message ?? error);
    process.exit(1);
  });
