import crypto from 'crypto';
import { Response } from 'express';
import jwt from 'jsonwebtoken';
import { hashToken } from '@shared/config';
import { Token } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS, cookieOptions } from './cookies';

const ISSUER = 'Fundi';

/** 서버 시작 시 필수 환경변수를 검사한다. (없으면 첫 로그인에서야 오류가 나는 것을 막음) */
export const assertRequiredEnv = () => {
  const missing = ['PRIVATE_KEY', 'REFRESH_TOKEN_SECRET'].filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`필수 환경변수가 없습니다: ${missing.join(', ')}`);
  }
};

export const signAccessToken = (user: { userId: number; email?: string }) =>
  jwt.sign({ userId: user.userId, email: user.email }, process.env.PRIVATE_KEY as string, {
    expiresIn: '30m',
    issuer: ISSUER,
  });

/** payload는 userId뿐이다. (email이 들어가면 긴 이메일에서 토큰이 길어짐) `jwtid`로 발급마다 고유하게 만든다. */
export const signRefreshToken = (userId: number) =>
  jwt.sign({ userId }, process.env.REFRESH_TOKEN_SECRET as string, {
    expiresIn: '7d',
    issuer: ISSUER,
    jwtid: crypto.randomUUID(),
  });

export const verifyRefreshToken = (token: string): { userId: number } =>
  jwt.verify(token, process.env.REFRESH_TOKEN_SECRET as string, { issuer: ISSUER }) as { userId: number };

/** 토큰 두 개를 발급하고 `tokens`에 저장한 뒤 쿠키로 내려준다. 만료된 이전 토큰 행은 함께 정리한다. */
export const issueTokens = async (user: { userId: number; email?: string }, res: Response) => {
  const accessToken = signAccessToken(user);
  const refreshToken = signRefreshToken(user.userId);

  const tokenRepo = AppDataSource.getRepository(Token);
  await tokenRepo
    .createQueryBuilder()
    .delete()
    .where('user_id = :userId AND expires_at < :now', { userId: user.userId, now: new Date() })
    .execute();
  await tokenRepo.save(
    tokenRepo.create({
      user: { userId: user.userId } as never,
      refreshToken: hashToken(refreshToken),
      revoke: false,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    })
  );

  res.cookie('accessToken', accessToken, cookieOptions(ACCESS_TOKEN_TTL_MS));
  res.cookie('refreshToken', refreshToken, cookieOptions(REFRESH_TOKEN_TTL_MS));
};

export const clearTokenCookies = (res: Response) => {
  res.clearCookie('accessToken', cookieOptions());
  res.clearCookie('refreshToken', cookieOptions());
};
