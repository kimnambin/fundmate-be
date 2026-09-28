import { NextFunction, Request, RequestHandler, Response } from 'express';

/** 컨트롤러에서 던지면 `errorHandler`가 해당 상태 코드로 응답한다. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface AuthUser {
  userId: number;
  email: string;
}

/**
 * 인증이 필요한 라우터 앞에 둔다.
 * 게이트웨이 규칙이 잘못되어 비로그인 요청이 넘어와도 401로 끝나고, 서비스는 종료되지 않는다.
 */
export const requireUser: RequestHandler = (_req, res, next) => {
  const user = res.locals.user as AuthUser | undefined;
  if (!user || !Number.isInteger(user.userId)) {
    res.status(401).json({ message: '로그인이 필요합니다.' });
    return;
  }
  next();
};

/** 로그인한 사용자 (`requireUser` 뒤에서만 사용) */
export const getUser = (res: Response): AuthUser => res.locals.user as AuthUser;

/** async 핸들러에서 던진 오류가 처리되지 않은 Promise 거부(프로세스 종료)가 되지 않도록 `next`로 넘긴다. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** 양의 정수 ID만 통과. `NaN`, 음수, 소수, 문자열 섞인 값은 null */
export const parseId = (value: unknown): number | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export interface Paging {
  page: number;
  limit: number;
  offset: number;
}

/** `?page=1&limit=50`. 잘못된 값은 기본값으로 대체하고 limit은 `maxLimit`을 넘지 못한다. */
export const parsePaging = (query: Request['query'], defaultLimit = 100, maxLimit = 100): Paging => {
  const page = parseId(query.page) ?? 1;
  const limit = Math.min(parseId(query.limit) ?? defaultLimit, maxLimit);
  return { page, limit, offset: (page - 1) * limit };
};

/**
 * 전역 에러 핸들러. 모든 라우터 뒤에 등록한다.
 * 요청 본문에는 비밀번호 등이 있을 수 있으므로 오류 객체 전체가 아니라 이름과 메시지만 기록한다.
 */
export const errorHandler = (err: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ message: err.message });
    return;
  }

  // body-parser(잘못된 JSON, 너무 큰 본문) 등 클라이언트 오류
  if (typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    res.status(err.status).json({ message: '요청 값이 잘못되었습니다.' });
    return;
  }

  console.error(`[ERROR] ${req.method} ${req.path} → ${err.name}: ${err.message}`);
  res.status(500).json({ message: '서버 오류가 발생했습니다.' });
};
