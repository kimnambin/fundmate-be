const SGIS_BASE_URL = 'https://sgisapi.kostat.go.kr/OpenAPI3';

export const SGIS_AUTH_URL = `${SGIS_BASE_URL}/auth/authentication.json`;

export const SGIS_STATS_URL = {
  people: `${SGIS_BASE_URL}/stats/searchpopulation.json`,
  household: `${SGIS_BASE_URL}/stats/household.json`,
  house: `${SGIS_BASE_URL}/stats/house.json`,
} as const;

export type Keyword = keyof typeof SGIS_STATS_URL;

export const KEYWORDS = Object.keys(SGIS_STATS_URL) as Keyword[];

/** SGIS 호출 1건당 타임아웃 */
export const SGIS_TIMEOUT_MS = 5000;
/** 요청 하나가 재시도를 포함해 SGIS에 쓸 수 있는 전체 시간 (게이트웨이 타임아웃 10초보다 짧게) */
export const REQUEST_DEADLINE_MS = 8000;
/** `-401` 재시도 횟수와 대기 시간 */
export const MAX_TOKEN_RETRY = 3;
export const RETRY_DELAY_MS = 200;

/** 확정된 연도별 통계라 오래 캐시해도 된다. */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 500;

/** 조회 연도. 환경변수 `PUBLIC_DATA_YEARS=2019,2020,...`로 바꿀 수 있다. */
export const getYears = (): number[] => {
  const parsed = (process.env.PUBLIC_DATA_YEARS ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isInteger(v) && v > 1900 && v < 3000);
  return parsed.length > 0 ? parsed : [2019, 2020, 2021, 2022, 2023];
};
