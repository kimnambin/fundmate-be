import { HttpError } from '@shared/config';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_MAX_LENGTH = 100;
export const NICKNAME_MAX_LENGTH = 45;

const bad = (message: string) => new HttpError(400, message);

/** 문자열 이메일(형식, 100자 이하)만 통과. `undefined`/`null`이 DB 조회 조건으로 들어가는 것을 막는다. */
export const requireEmail = (value: unknown): string => {
  if (typeof value !== 'string') throw bad('이메일 입력 필요');
  const email = value.trim();
  if (email === '' || email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw bad('이메일 형식이 올바르지 않습니다.');
  }
  return email;
};

/** 6자리 숫자 인증 코드 */
export const requireCode = (value: unknown): string => {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) throw bad('인증 코드 형식이 올바르지 않습니다.');
  return value.trim();
};

export const requireNickname = (value: unknown): string => {
  if (typeof value !== 'string') throw bad('닉네임 입력 필요');
  const nickname = value.trim();
  if (nickname === '' || nickname.length > NICKNAME_MAX_LENGTH) {
    throw bad(`닉네임은 1~${NICKNAME_MAX_LENGTH}자로 입력해 주세요.`);
  }
  return nickname;
};

export const requirePositiveInt = (value: unknown, message: string): number => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw bad(message);
  return n;
};

/** MySQL 오류 코드 (TypeORM `QueryFailedError`는 `driverError.code`, 일부는 `code`) */
export const dbErrorCode = (err: unknown): string | undefined => {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.driverError?.code ?? e?.code;
};
