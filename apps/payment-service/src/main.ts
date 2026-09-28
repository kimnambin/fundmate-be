import express from 'express';
import dotenv from 'dotenv';
import healthRouter from './routes/health-route';
import paymentRouter from './routes/payment-route';
import reservationRouter from './routes/reservation-route';
import statisticsRouter from './routes/statistics-route';
import { AppDataSource } from './data-source';
import { serviceConfig, headerToLocals, errorHandler, requireUser } from '@shared/config';
import { httpLogger } from '@shared/logger';
dotenv.config();

const { port, host, url } = serviceConfig['payment-service'];

const app = express();

app.use(httpLogger);
app.use(express.json({ limit: '20kb' }));
app.use(headerToLocals);

app.use('/health', healthRouter);

// 이 서비스의 모든 API는 로그인이 필요하다. 게이트웨이 규칙과 무관하게 서비스에서도 막는다.
app.use(['/payments', '/reservations', '/statistics'], requireUser);
app.use('/payments', paymentRouter);
app.use('/reservations', reservationRouter);
app.use('/statistics', statisticsRouter);
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
