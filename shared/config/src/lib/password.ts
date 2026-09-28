import crypto from 'crypto';
import { promisify } from 'util';

const pbkdf2 = promisify(crypto.pbkdf2);

const KEY_LENGTH = 64;
const DIGEST = 'sha512';
/** 기존 사용자 해시 (salt에 버전 접두사가 없음) */
const LEGACY_ITERATIONS = 10000;
/** OWASP 권장 (PBKDF2-HMAC-SHA512) */
const ITERATIONS = 210000;
/** 새 해시의 salt 접두사. 접두사가 없으면 기존(legacy) 해시로 본다. DB 스키마 변경 없이 버전을 구분하기 위함. */
const VERSION_PREFIX = 'v2$';

export const PASSWORD_MIN_LENGTH = 8;
/** pbkdf2 입력 길이 제한 (거대한 입력으로 CPU를 쓰게 하는 것을 막음) */
export const PASSWORD_MAX_LENGTH = 128;

export interface StoredPassword {
  password?: string | null;
  salt?: string | null;
}

const derive = async (plain: string, salt: string, iterations: number) =>
  (await pbkdf2(plain, salt, iterations, KEY_LENGTH, DIGEST)).toString('base64');

/** 새 비밀번호 해시. 반환값을 그대로 `users.password`, `users.salt`에 저장한다. */
export const hashPassword = async (plain: string): Promise<{ password: string; salt: string }> => {
  const salt = VERSION_PREFIX + crypto.randomBytes(32).toString('base64');
  return { password: await derive(plain, salt, ITERATIONS), salt };
};

const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * 비밀번호 검증. 기존(10,000회) 해시도 검증하며, 맞으면 `needsRehash`로 새 방식 재해시가 필요함을 알린다.
 */
export const verifyPassword = async (
  plain: string,
  stored: StoredPassword
): Promise<{ valid: boolean; needsRehash: boolean }> => {
  if (!stored.password || !stored.salt) return { valid: false, needsRehash: false };

  const isCurrent = stored.salt.startsWith(VERSION_PREFIX);
  const hash = await derive(plain, stored.salt, isCurrent ? ITERATIONS : LEGACY_ITERATIONS);
  const valid = safeEqual(hash, stored.password);
  return { valid, needsRehash: valid && !isCurrent };
};

let dummy: Promise<{ password: string; salt: string }> | null = null;

/** 존재하지 않는 사용자에도 같은 비용을 쓰게 해 응답 시간으로 계정 존재 여부를 알 수 없게 한다. */
export const spendVerifyTime = async (plain: string): Promise<void> => {
  dummy ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(plain, await dummy);
};

export const isValidPasswordFormat = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH && value.length <= PASSWORD_MAX_LENGTH;
