import express, { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import { serviceConfig, headerToLocals } from '@shared/config';
import { httpLogger } from '@shared/logger';
import PublicDataRouter from './routes/PublicDataRouter';
dotenv.config();

const { port, host, url } = serviceConfig['public-service'];

const app = express();
app.use(httpLogger);
app.use(headerToLocals);
app.use(express.json());

app.use('/datas', PublicDataRouter);

app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'public-service', timestamp: new Date().toISOString() })
);

// 처리되지 않은 오류(잘못된 JSON 본문 등)는 400/500으로 응답한다.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('처리되지 않은 오류:', err.name, err.message);
  res.status(status).json({ message: status === 500 ? '서버 오류가 발생했습니다.' : '요청 값이 잘못되었습니다.' });
});

app.listen(port, host, () => {
  console.log(`[ ready ] ${url}`);
});
