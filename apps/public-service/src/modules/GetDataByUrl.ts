import axios from 'axios';
import { getAccessToken, resetAccessToken } from './GetAccessToken';
import { MAX_TOKEN_RETRY, RETRY_DELAY_MS, SGIS_TIMEOUT_MS } from './SgisConfig';
import { SgisApiError, SgisTimeoutError, describeError } from './SgisError';

export type SgisParams = Record<string, string | number | undefined>;

export interface YearResult {
  year: string | number | undefined;
  result: unknown;
}

/** SGIS `errCd` */
const ERR_OK = 0;
const ERR_NO_RESULT = -100;
const ERR_TOKEN = -401;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param deadline 이 시각(epoch ms)을 넘기면 더 시도하지 않고 `SgisTimeoutError`
 */
export const getDataByUrl = async (url: string, params: SgisParams, deadline?: number): Promise<YearResult> => {
  for (let attempt = 0; attempt <= MAX_TOKEN_RETRY; attempt++) {
    const remaining = deadline === undefined ? SGIS_TIMEOUT_MS : deadline - Date.now();
    if (remaining <= 0) {
      throw new SgisTimeoutError();
    }

    const token = await getAccessToken();

    let data;
    try {
      const res = await axios.get(url, {
        timeout: Math.min(SGIS_TIMEOUT_MS, remaining),
        params: { ...params, accessToken: token },
      });
      data = res.data;
    } catch (error) {
      // AxiosError를 통째로 찍으면 config.params의 accessToken이 로그에 남는다.
      console.error('SGIS API 호출 실패:', describeError(error));
      throw error;
    }

    const errCd = Number(data?.errCd ?? ERR_OK);

    if (errCd === ERR_TOKEN) {
      resetAccessToken(token);
      if (attempt < MAX_TOKEN_RETRY) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
      }
      continue;
    }

    if (errCd === ERR_NO_RESULT) {
      return { year: params.year, result: [] };
    }

    if (errCd !== ERR_OK) {
      console.error(`SGIS API 오류 errCd=${errCd} errMsg=${data?.errMsg}`);
      throw new SgisApiError(errCd, String(data?.errMsg ?? ''));
    }

    return { year: params.year, result: data?.result };
  }

  console.error('재시도 초과!');
  throw new SgisApiError(ERR_TOKEN, `accessToken 오류로 ${MAX_TOKEN_RETRY}회 재시도 후 실패`);
};
