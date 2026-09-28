import pino from 'pino';
import pinoHttp from 'pino-http';
import { IncomingMessage } from 'http';
import { Request } from 'express';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
});

const skipPrefixes = ['/assets', '/docs'];
const skipExact = new Set(['/health-checks', '/health', '/favicon.ico']);

/** 값이 로그에 남으면 안 되는 쿼리 키 (인증 코드, 토큰, OAuth state 등) */
const SENSITIVE_KEY = /pass|pwd|secret|token|code|state|key|auth|cookie|session/i;
const MASK = '***';

const maskParams = (params: URLSearchParams) => {
  for (const key of new Set(params.keys())) {
    if (SENSITIVE_KEY.test(key)) params.set(key, MASK);
  }
  return params;
};

/** `/oauth/google/callback?code=abc&state=xyz` → `/oauth/google/callback?code=***&state=***` */
export const redactUrl = (url: string): string => {
  const queryStart = url.indexOf('?');
  if (queryStart === -1) return url;
  const params = maskParams(new URLSearchParams(url.slice(queryStart + 1)));
  return `${url.slice(0, queryStart)}?${params.toString().replace(/%2A%2A%2A/g, MASK)}`;
};

export const redactQuery = (query: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(query).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? MASK : v]));

export const httpLogger = pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => {
      const url = req.url || '';
      return skipExact.has(url) || skipPrefixes.some((p) => url.startsWith(p));
    },
  },
  serializers: {
    req: () => undefined,
    res: () => undefined,
  },
  // 요청 본문(비밀번호, 인증 코드, 결제 정보 등)은 기록하지 않는다.
  customReceivedMessage: (rawReq: IncomingMessage, _res) => {
    const req = rawReq as Request;
    const path = (req.url || '').split('?')[0];
    const parts = [`[REQUEST] (---) ${req.method}: ${path}`];
    if (req.query && Object.keys(req.query).length > 0) {
      parts.push(`query=${JSON.stringify(redactQuery(req.query as Record<string, unknown>))}`);
    }
    return parts.join('\n') + '\n';
  },
  customSuccessMessage: (req, res, responseTime) =>
    `[SUCCESS] (${res.statusCode}) ${req.method}: ${redactUrl(req.url || '')} in ${responseTime}ms`,
  customErrorMessage: (req, res, err) =>
    `[ERROR] (${res.statusCode}) ${req.method}: ${redactUrl(req.url || '')} → ${err.message}`,
  customLogLevel: (req, res) => {
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});
