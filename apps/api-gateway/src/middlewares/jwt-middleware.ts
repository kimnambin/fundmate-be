import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ensureAuthorization } from './ensureAuthorization';
import { jwtErrorHandler } from './jwtErrorHandler';

/**
 * 쿠키의 JWT를 검증해 `res.locals.user`를 채운다.
 * `res.locals.tokens.refreshToken`은 액세스 토큰이 만료/없음이어도 채워서,
 * 토큰 갱신(`POST /auth/token`)처럼 로그인 전 단계에서도 리프레시 토큰을 서비스에 넘길 수 있게 한다.
 */
export function jwtMiddleware(required: boolean) {
  return (req: Request, res: Response, next: NextFunction) => {
    const accessToken = req.cookies?.accessToken;
    const refreshToken = req.cookies?.refreshToken;

    // 클라이언트가 보낸 값이 아니라 이 미들웨어가 만든 값만 서비스로 전달된다.
    res.locals.user = undefined;
    res.locals.tokens = { refreshToken: typeof refreshToken === 'string' ? refreshToken : undefined };

    if (!accessToken) {
      if (!required) return next();
      // 리프레시 토큰만 남아 있으면 액세스 토큰이 만료된 것이므로 갱신을 안내한다.
      return res
        .status(StatusCodes.UNAUTHORIZED)
        .json({ message: refreshToken ? '토큰 만료' : '로그인이 필요합니다.' });
    }

    const result = ensureAuthorization(req);
    if (result instanceof Error) {
      if (required) return jwtErrorHandler(result, res);
      return next();
    }

    res.locals.user = { userId: result.userId, email: result.email };
    return next();
  };
}
