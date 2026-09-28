import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import AiChat from './routes/aichat';
import { serviceConfig, headerToLocals, errorHandler } from '@shared/config';
import { httpLogger } from '@shared/logger';

const { port, host, url } = serviceConfig['ai-service'];

const app = express();
app.use(httpLogger);
app.use(headerToLocals);

app.get('/health', (_req, res) =>
  res.status(200).json({ status: 'ok', service: 'ai-service', timestamp: new Date().toISOString() })
);

// 프롬프트에 들어가는 본문은 1,000자 이하이므로 요청 본문도 작게 받는다.
app.use(express.json({ limit: '20kb' }));
app.use('/ai', AiChat);

app.use((_req, res) => res.status(404).json({ message: 'Not Found', error: 'Not Found' }));

// 기존 응답은 { error } 키를 썼다. 클라이언트 호환을 위해 message와 함께 내려준다.
app.use((err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
  const send = res.json.bind(res);
  res.json = ((body: { message?: string }) =>
    send(body?.message ? { ...body, error: body.message } : body)) as typeof res.json;
  errorHandler(err, req, res, next);
});

app.listen(port, host, () => {
  console.log(`[ ready ] ${url}`);
});
