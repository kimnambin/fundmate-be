import express from 'express';
import dotenv from 'dotenv';
import { AppDataSource } from './data-source';
import userRouter from './routes/users';
import { serviceConfig, headerToLocals, errorHandler } from '@shared/config';
import { httpLogger } from '@shared/logger';
dotenv.config();

const { port, host, url } = serviceConfig['user-service'];

const app = express();

app.use(httpLogger);
app.use(express.json({ limit: '20kb' }));
app.use(headerToLocals);

app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'user-service', timestamp: new Date().toISOString() })
);

app.use('/users', userRouter);
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
