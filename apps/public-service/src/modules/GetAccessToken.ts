import axios from 'axios';
import { SGIS_AUTH_URL, SGIS_TIMEOUT_MS } from './SgisConfig';
import { describeError } from './SgisError';

interface CachedToken {
  value: string;
  /** epoch ms. 만료 시각을 모르면 undefined (`-401`을 받을 때 재발급) */
  expiresAt?: number;
}

/** 만료 직전에 요청이 실패하지 않도록 미리 갱신하는 여유 시간 */
const EXPIRY_MARGIN_MS = 60 * 1000;

let cache: CachedToken | null = null;
let pending: Promise<CachedToken> | null = null;

const isFresh = (token: CachedToken) => token.expiresAt === undefined || token.expiresAt - EXPIRY_MARGIN_MS > Date.now();

const issueToken = async (): Promise<CachedToken> => {
  const consumer_key = process.env.PUBLIC_CONSUMER_KEY;
  const consumer_secret = process.env.PUBLIC_CONSUMER_SECRET;

  if (!consumer_key || !consumer_secret) {
    console.error('SGIS API 키가 설정되지 않았습니다.');
    throw new Error('SGIS API 키가 .env에 설정되지 않았습니다.');
  }

  try {
    const res = await axios.get(SGIS_AUTH_URL, {
      params: { consumer_key, consumer_secret },
      timeout: SGIS_TIMEOUT_MS,
    });

    const result = res.data?.result;
    if (!result?.accessToken) {
      throw new Error(`SGIS 인증 응답에 accessToken이 없습니다. errCd=${res.data?.errCd} errMsg=${res.data?.errMsg}`);
    }

    // 응답의 `accessTimeout`(epoch ms)을 만료 시각으로 사용. 없거나 이상한 값이면 무시한다.
    const timeout = Number(result.accessTimeout);
    return {
      value: result.accessToken as string,
      expiresAt: Number.isFinite(timeout) && timeout > Date.now() ? timeout : undefined,
    };
  } catch (err) {
    // AxiosError를 통째로 찍으면 config.params에 consumer_secret이 포함된다.
    console.error('accessToken 요청 실패:', describeError(err));
    throw err;
  }
};

/** 동시에 여러 요청이 와도 인증은 한 번만 나간다. */
export const getAccessToken = async (): Promise<string> => {
  if (cache && isFresh(cache)) {
    return cache.value;
  }

  if (!pending) {
    pending = issueToken()
      .then((token) => {
        cache = token;
        return token;
      })
      .finally(() => {
        pending = null;
      });
  }
  return (await pending).value;
};

/**
 * 토큰을 무효화한다. 다른 요청이 그 사이 새로 받은 토큰은 지우지 않도록,
 * 실패한 토큰을 넘기면 그 토큰일 때만 지운다.
 */
export const resetAccessToken = (failedToken?: string) => {
  if (failedToken === undefined || cache?.value === failedToken) {
    cache = null;
  }
};
