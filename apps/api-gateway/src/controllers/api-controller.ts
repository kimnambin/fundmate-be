import { Request, Response, NextFunction } from 'express';
import StatusCode from 'http-status-codes';
import { serviceConfig, HTTPMethod, AuthContext, serviceClients } from '@shared/config';
import { jwtMiddleware } from '../middlewares/jwt-middleware';
import { isAuthRequired } from '../middlewares/jwt-rules';

/** 리프레시 토큰을 받아야 하는 서비스 (토큰 갱신/로그아웃, 회원 탈퇴). 나머지 서비스에는 토큰 원문을 넘기지 않는다. */
const REFRESH_TOKEN_SERVICES = new Set(['auth-service', 'user-service']);

/** 서비스 → 클라이언트로 그대로 전달하는 응답 헤더 (OAuth 리다이렉트와 쿠키) */
const PASS_THROUGH_HEADERS = ['set-cookie', 'location', 'retry-after'];

// 서버 결정 미들웨어
export function decideService(req: Request, res: Response, next: NextFunction) {
  const service = Object.values(serviceConfig).find((s) => s.base.some((base) => req.path.startsWith(base)));
  if (!service) {
    return res.status(StatusCode.NOT_FOUND).json({ message: 'Service not found' });
  }
  res.locals.service = service;
  return next();
}

// 토큰 확인 여부결정 미들웨어
export function decideJwt(req: Request, res: Response, next: NextFunction) {
  const required = isAuthRequired(res.locals.service.jwtRules, req.method, req.path);
  return jwtMiddleware(required)(req, res, next);
}

/** 네트워크 오류를 게이트웨이 오류 코드로 변환. 서비스가 응답한 경우는 그대로 전달하므로 여기 오지 않는다. */
const toGatewayError = (err: unknown): { status: number; message: string } | null => {
  const code = (err as { code?: string })?.code;
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') {
    return { status: StatusCode.GATEWAY_TIMEOUT, message: '서비스 응답이 지연되고 있습니다.' };
  }
  if (code && ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(code)) {
    return { status: StatusCode.BAD_GATEWAY, message: '서비스에 연결할 수 없습니다.' };
  }
  return null;
};

// 라우터 미들웨어
export async function forwardRequest(req: Request, res: Response, next: NextFunction) {
  try {
    const service = res.locals.service.name as string;
    const client = serviceClients[service];

    // 요청마다 새로 만든 인증 정보. 이전 요청의 사용자 정보가 남지 않는다.
    const auth: AuthContext = {
      userId: res.locals.user?.userId,
      email: res.locals.user?.email,
      refreshToken: REFRESH_TOKEN_SERVICES.has(service) ? res.locals.tokens?.refreshToken : undefined,
    };

    const response = await client.forward(req.method as HTTPMethod, req.path, {
      data: req.body,
      params: req.query as Record<string, unknown>,
      headers: req.ip ? { 'x-forwarded-for': req.ip } : undefined,
      auth,
    });

    for (const name of PASS_THROUGH_HEADERS) {
      const value = response.headers[name];
      if (value !== undefined) res.setHeader(name, value as string | string[]);
    }

    res.status(response.status);
    const { data } = response;
    if (data === undefined || data === '' || response.status === 204 || response.status === 304) {
      res.end();
    } else if (typeof data === 'object') {
      res.json(data);
    } else {
      res.send(data);
    }
  } catch (err) {
    const gatewayError = toGatewayError(err);
    if (gatewayError) {
      console.error(`[API Gateway] ${res.locals.service?.name} 호출 실패: ${(err as Error).message}`);
      res.status(gatewayError.status).json({ message: gatewayError.message });
      return;
    }
    next(err);
  }
}
