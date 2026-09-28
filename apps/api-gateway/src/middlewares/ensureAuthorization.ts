import { Request } from 'express';
import jwt from 'jsonwebtoken';
import { DecodedJwt } from '@shared/types';

/** 쿠키의 액세스 토큰을 검증한다. 실패하면 Error를 돌려준다. (HS256 대칭키, auth-service가 발급) */
export const ensureAuthorization = (req: Request): DecodedJwt | Error => {
  try {
    const token = req.cookies?.accessToken;

    if (!token) {
      throw new ReferenceError('JWT must be provided');
    }
    return jwt.verify(token, process.env.PRIVATE_KEY as string, {
      algorithms: ['HS256'],
      issuer: 'Fundi',
    }) as DecodedJwt;
  } catch (err) {
    return err instanceof Error ? err : new Error('알 수 없는 에러가 발생했습니다.');
  }
};
