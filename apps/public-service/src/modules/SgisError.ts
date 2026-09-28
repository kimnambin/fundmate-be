import { isAxiosError } from 'axios';

/** SGIS가 HTTP 200에 `errCd`로 알려 온 오류 */
export class SgisApiError extends Error {
  constructor(readonly errCd: number, readonly errMsg: string) {
    super(`SGIS 오류 errCd=${errCd} errMsg=${errMsg}`);
    this.name = 'SgisApiError';
  }
}

/** 재시도/전체 제한 시간을 넘긴 경우 */
export class SgisTimeoutError extends Error {
  constructor(message = 'SGIS 호출 제한 시간 초과') {
    super(message);
    this.name = 'SgisTimeoutError';
  }
}

/**
 * 로그용 오류 요약.
 * `AxiosError`를 통째로 출력하면 `config.params`의 consumer_secret / accessToken이 그대로 찍히므로
 * 메시지, 코드, 상태 코드만 남긴다.
 */
export const describeError = (err: unknown): string => {
  if (isAxiosError(err)) {
    return `AxiosError code=${err.code ?? '-'} status=${err.response?.status ?? '-'} message=${err.message}`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
};

/** 외부(SGIS) 오류를 HTTP 상태로 변환 */
export const toHttpStatus = (err: unknown): number => {
  if (err instanceof SgisTimeoutError) return 504;
  if (isAxiosError(err)) {
    return err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ? 504 : 502;
  }
  if (err instanceof SgisApiError) return 502;
  return 500;
};
