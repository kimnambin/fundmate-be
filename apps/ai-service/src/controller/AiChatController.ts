import { Request, Response } from 'express';
import { HttpError, WindowCounter, getUser } from '@shared/config';
import { callGroq } from '../modules/groq';
import { EXPAND_SYSTEM, SUMMARIZE_SYSTEM, expandUser, sanitizeOutput, summarizeUser } from '../modules/prompts';
import { parseExpandBody, parseSummarizeBody } from '../modules/validation';

/** 유료 LLM 호출이라 사용자별로 분당/일일 횟수를 제한한다. (환경변수로 조정) */
const perMinute = Number(process.env.AI_RATE_PER_MIN) || 5;
const perDay = Number(process.env.AI_DAILY_LIMIT) || 100;
const minuteCounter = new WindowCounter(60 * 1000);
const dayCounter = new WindowCounter(24 * 60 * 60 * 1000);

/** 검증을 통과한 요청만 횟수에 넣는다. 한도를 넘으면 429 */
const consumeQuota = (userId: number) => {
  const key = String(userId);
  if (minuteCounter.count(key) >= perMinute || dayCounter.count(key) >= perDay) {
    throw new HttpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  }
  minuteCounter.hit(key);
  dayCounter.hit(key);
};

export const summarize = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const message = parseSummarizeBody(req.body);
  consumeQuota(userId);

  const summary = await callGroq(
    [
      { role: 'system', content: SUMMARIZE_SYSTEM },
      { role: 'user', content: summarizeUser(message) },
    ],
    { temperature: 0.7, maxTokens: 100 }
  );

  res.json({ summary });
};

export const requests = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const input = parseExpandBody(req.body);
  consumeQuota(userId);

  const raw = await callGroq(
    [
      { role: 'system', content: EXPAND_SYSTEM },
      { role: 'user', content: expandUser(input) },
    ],
    { temperature: 0.9, maxTokens: 2000 }
  );

  res.json({ expanded_Idea: sanitizeOutput(raw) });
};
