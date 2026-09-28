import crypto from 'crypto';

/** 리프레시 토큰은 원문 대신 SHA-256(hex, 64자)을 `tokens.refresh_token`에 저장한다. */
export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** DB에서 리프레시 토큰을 찾을 때의 후보. (해시 저장 이전에 저장된 원문 행도 만료 전까지 인정) */
export const refreshTokenKeys = (token: string) => [hashToken(token), token];
