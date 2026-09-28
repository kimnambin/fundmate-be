import 'reflect-metadata';
import express from 'express';
import dotenv from 'dotenv';
import { AppDataSource } from './data-source';
import { serviceConfig, headerToLocals, errorHandler } from '@shared/config';
import { httpLogger } from '@shared/logger';
import likeRouter from './routes/likes';
import commentRouter from './routes/comment';
import interactMainRouter from './routes/interaction-main';
dotenv.config();

const { port, host, url } = serviceConfig['interaction-service'];

const app = express();
app.use(httpLogger);
app.use(headerToLocals);
// 댓글은 500자로 제한되므로 본문도 작게 받는다.
app.use(express.json({ limit: '20kb' }));

app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'interaction-service', timestamp: new Date().toISOString() })
);

app.use('/users/likes', likeRouter);
app.use('/comment', commentRouter);
app.use('/interactionmain', interactMainRouter);
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
