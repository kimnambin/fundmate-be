import { isAxiosError } from 'axios';
import { HttpError } from '@shared/config';

/**
 * 다른 서비스 호출 실패를 HTTP 오류로 바꾼다.
 * - 400/404/409/422 등 요청 문제는 그 상태 그대로 전달 (사용자가 고칠 수 있음)
 * - 401/403은 사용자 신원이 서비스 간에 어긋난 것이므로 502
 * - 그 밖의 5xx / 연결 실패는 502, 시간 초과는 504
 */
export const downstream = async <T>(call: Promise<T>): Promise<T> => {
  try {
    return await call;
  } catch (err) {
    if (!isAxiosError(err)) throw err;

    const status = err.response?.status;
    if (status && [400, 404, 409, 422].includes(status)) {
      const message = (err.response?.data as { message?: string } | undefined)?.message ?? '요청을 처리할 수 없습니다.';
      throw new HttpError(status, message);
    }
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      throw new HttpError(504, '다른 서비스 응답이 지연되고 있습니다.');
    }
    console.error(`다른 서비스 호출 실패: status=${status ?? '-'} code=${err.code ?? '-'} ${err.config?.url ?? ''}`);
    throw new HttpError(502, '다른 서비스 호출에 실패했습니다.');
  }
};

/** 404를 "데이터 없음"으로 취급해야 하는 호출용 */
export const orEmpty = async <T, E>(call: Promise<T>, empty: E): Promise<T | E> => {
  try {
    return await call;
  } catch (err) {
    if (isAxiosError(err) && err.response?.status === 404) return empty;
    throw err;
  }
};
