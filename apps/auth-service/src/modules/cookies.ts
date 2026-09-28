import { CookieOptions } from 'express';

export const ACCESS_TOKEN_TTL_MS = 30 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 토큰 쿠키 옵션. 운영이 HTTPS면 `COOKIE_SECURE=true`로 설정한다.
 * (`NODE_ENV`는 Docker에서 `docker`로 쓰이므로 별도 변수를 사용)
 */
export const cookieOptions = (maxAge?: number): CookieOptions => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax',
  path: '/',
  ...(maxAge === undefined ? {} : { maxAge }),
});
