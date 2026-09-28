import type { Request, Response } from 'express';

const { AxiosError } = jest.requireActual('axios') as typeof import('axios');
const mockGet = jest.fn();
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  return { ...actual, __esModule: true, default: { ...actual.default, get: (...args: unknown[]) => mockGet(...args) } };
});

// 모듈 상태(토큰/응답 캐시)를 테스트마다 초기화하기 위해 beforeEach에서 require 한다.
let getDataByOption: typeof import('../controller/PublicDataController').getDataByOption;
let getDataByKeyword: typeof import('../controller/PublicDataController').getDataByKeyword;
let parseKeywordBody: typeof import('../modules/RequestBodyValidation').parseKeywordBody;
let parseOptionBody: typeof import('../modules/RequestBodyValidation').parseOptionBody;
let describeError: typeof import('../modules/SgisError').describeError;
let clearCache: typeof import('../modules/ResponseCache').clearCache;

const get = mockGet;
const AUTH = 'auth/authentication.json';

const authOk = (token = 'TOKEN', extra: object = {}) => ({ data: { errCd: 0, result: { accessToken: token, ...extra } } });
const statOk = (payload: unknown = [{ v: 1 }]) => ({ data: { errCd: 0, result: payload } });

/** URL별로 응답을 돌려주는 SGIS 가짜 */
const fakeSgis = (stat: (params: Record<string, unknown>) => unknown = () => statOk()) =>
  get.mockImplementation(async (url: string, cfg: { params: Record<string, unknown> }) =>
    url.includes(AUTH) ? authOk() : stat(cfg.params)
  );

const statCalls = () => get.mock.calls.filter(([url]) => !String(url).includes(AUTH));
const authCalls = () => get.mock.calls.filter(([url]) => String(url).includes(AUTH));

const mockRes = () => {
  const res: { statusCode?: number; body?: unknown } = {};
  const r = {
    status: (code: number) => ((res.statusCode = code), r),
    json: (body: unknown) => ((res.body = body), r),
  };
  return { res, r: r as unknown as Response };
};
const call = async (handler: (req: Request, res: Response) => Promise<unknown>, body: unknown) => {
  const { res, r } = mockRes();
  await handler({ body } as Request, r);
  return res;
};

/** 모듈 상태(토큰 캐시)를 비운 GetAccessToken */
const freshTokenModule = () => {
  let mod!: typeof import('../modules/GetAccessToken');
  jest.isolateModules(() => {
    mod = require('../modules/GetAccessToken');
  });
  return mod;
};

beforeEach(() => {
  jest.resetModules();
  get.mockReset();
  ({ getDataByOption, getDataByKeyword } = require('../controller/PublicDataController'));
  ({ parseKeywordBody, parseOptionBody } = require('../modules/RequestBodyValidation'));
  ({ describeError } = require('../modules/SgisError'));
  ({ clearCache } = require('../modules/ResponseCache'));
  process.env.PUBLIC_CONSUMER_KEY = 'KEY-abc123';
  process.env.PUBLIC_CONSUMER_SECRET = 'SECRET-do-not-log-9f8e7d';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe('H1: 캐시', () => {
  it('같은 option 요청은 SGIS를 한 번만 호출한다', async () => {
    fakeSgis();
    const body = { age_group: 32, gender: 2, area: 11 };
    const first = await call(getDataByOption, body);
    const second = await call(getDataByOption, body);
    expect(first.statusCode).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(statCalls()).toHaveLength(5);
  });

  it('동시에 같은 요청이 와도 SGIS 호출은 한 번분이다', async () => {
    fakeSgis();
    const body = { people: true };
    await Promise.all([call(getDataByKeyword, body), call(getDataByKeyword, body), call(getDataByKeyword, body)]);
    expect(statCalls()).toHaveLength(5);
  });

  it('실패한 응답은 캐시하지 않는다', async () => {
    get.mockRejectedValue(new AxiosError('boom', 'ECONNRESET'));
    const bad = await call(getDataByKeyword, { house: true });
    expect(bad.statusCode).toBe(502);
    fakeSgis();
    const ok = await call(getDataByKeyword, { house: true });
    expect(ok.statusCode).toBe(200);
  });
});

describe('H2: 로그에 시크릿이 남지 않는다', () => {
  it('인증 실패 시 consumer_secret이 로그에 없다', async () => {
    const err = new AxiosError('Network Error', 'ERR_NETWORK', {
      params: { consumer_key: 'KEY-abc123', consumer_secret: 'SECRET-do-not-log-9f8e7d' },
    } as never);
    get.mockRejectedValue(err);
    const res = await call(getDataByOption, { age_group: 32, gender: 2 });
    expect(res.statusCode).toBe(502);
    const logged = JSON.stringify((console.error as jest.Mock).mock.calls);
    expect(logged).not.toContain('SECRET-do-not-log');
    expect(logged).not.toContain('KEY-abc123');
  });

  it('통계 실패 시 accessToken이 로그에 없다', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes(AUTH)) return authOk('LEAK-ME-TOKEN');
      throw new AxiosError('Network Error', 'ERR_NETWORK', { params: { accessToken: 'LEAK-ME-TOKEN' } } as never);
    });
    await call(getDataByKeyword, { people: true });
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain('LEAK-ME-TOKEN');
  });

  it('describeError는 메시지/코드/상태만 남긴다', () => {
    const err = new AxiosError('x', 'ECONNABORTED', { params: { consumer_secret: 'HIDDEN' } } as never);
    expect(describeError(err)).not.toContain('HIDDEN');
    expect(describeError(err)).toContain('ECONNABORTED');
  });
});

describe('M1: SGIS 오류 응답', () => {
  it('errCd가 -100이면 빈 결과로 응답한다', async () => {
    fakeSgis(() => ({ data: { errCd: -100, errMsg: '결과가 존재하지 않습니다.' } }));
    const res = await call(getDataByOption, { age_group: 32, gender: 2 });
    expect(res.statusCode).toBe(200);
    expect((res.body as { result: unknown[] }[])[0].result).toEqual([]);
  });

  it('그 밖의 errCd는 502로 응답한다', async () => {
    fakeSgis(() => ({ data: { errCd: -300, errMsg: '호출 한도 초과' } }));
    const res = await call(getDataByOption, { age_group: 32, gender: 2 });
    expect(res.statusCode).toBe(502);
  });

  it('타임아웃은 504로 응답한다', async () => {
    get.mockImplementation(async (url: string) => {
      if (url.includes(AUTH)) return authOk();
      throw new AxiosError('timeout', 'ECONNABORTED');
    });
    const res = await call(getDataByKeyword, { people: true });
    expect(res.statusCode).toBe(504);
  });
});

describe('M2: 토큰 캐시', () => {
  it('콜드 스타트에서도 인증은 한 번만 나간다', async () => {
    fakeSgis();
    await call(getDataByOption, { age_group: 32, gender: 2 });
    expect(authCalls()).toHaveLength(1);
    expect(statCalls()).toHaveLength(5);
  });

  it('accessTimeout이 임박하면 다시 발급받는다', async () => {
    const soon = Date.now() + 30_000; // 여유 시간(60초)보다 가까움
    get.mockResolvedValueOnce(authOk('T1', { accessTimeout: String(soon) })).mockResolvedValueOnce(authOk('T2'));
    const { getAccessToken } = freshTokenModule();
    expect(await getAccessToken()).toBe('T1');
    expect(await getAccessToken()).toBe('T2');
  });

  it('accessTimeout이 충분히 남았으면 재사용한다', async () => {
    get.mockResolvedValue(authOk('T1', { accessTimeout: String(Date.now() + 3600_000) }));
    const { getAccessToken } = freshTokenModule();
    await getAccessToken();
    await getAccessToken();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('resetAccessToken(실패한 토큰)은 그 사이 새로 받은 토큰을 지우지 않는다', async () => {
    get.mockResolvedValueOnce(authOk('NEW'));
    const { getAccessToken, resetAccessToken } = freshTokenModule();
    await getAccessToken();
    resetAccessToken('OLD');
    await getAccessToken();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('-401이 계속되면 연도마다 최대 4회 시도 후 502', async () => {
    let issued = 0;
    get.mockImplementation(async (url: string) =>
      url.includes(AUTH) ? authOk(`T${++issued}`) : { data: { errCd: -401, errMsg: 'expired' } }
    );
    const res = await call(getDataByOption, { age_group: 32, gender: 2 });
    expect(res.statusCode).toBe(502);
    expect(statCalls().length).toBeLessThanOrEqual(5 * 4);
  }, 15000);

  it('-401 한 번 뒤에는 새 토큰으로 성공한다', async () => {
    let first = true;
    fakeSgis(() => {
      if (first) {
        first = false;
        return { data: { errCd: -401 } };
      }
      return statOk();
    });
    const res = await call(getDataByKeyword, { household: true });
    expect(res.statusCode).toBe(200);
  });

  it('키가 없으면 인증 요청 없이 실패한다', async () => {
    delete process.env.PUBLIC_CONSUMER_KEY;
    const { getAccessToken } = freshTokenModule();
    await expect(getAccessToken()).rejects.toThrow('SGIS API 키');
    expect(get).not.toHaveBeenCalled();
  });
});

describe('M3: 입력 검증', () => {
  it('keyword: 하나만 보내도 통과, 빠진 항목은 선택 안 함', () => {
    expect(parseKeywordBody({ people: true })).toEqual(['people']);
    expect(parseKeywordBody({ people: true, house: true, household: false })).toEqual(['people', 'house']);
  });

  it('keyword: 모두 false / 비어 있음 / 문자열 "false"는 거부', () => {
    expect(parseKeywordBody({ people: false, household: false, house: false })).toBeNull();
    expect(parseKeywordBody({})).toBeNull();
    expect(parseKeywordBody(undefined)).toBeNull();
    expect(parseKeywordBody({ people: 'false' })).toBeNull();
    expect(parseKeywordBody({ people: 1 })).toBeNull();
  });

  it('keyword: 거부되면 400이고 SGIS를 호출하지 않는다', async () => {
    const res = await call(getDataByKeyword, { people: 'false', household: false, house: false });
    expect(res.statusCode).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('option: 숫자와 숫자 문자열을 허용하고 area 0/생략은 전국', () => {
    expect(parseOptionBody({ age_group: 32, gender: 2, area: 11 })).toEqual({ ageGroup: '32', gender: '2', area: '11' });
    expect(parseOptionBody({ age_group: '32', gender: '0', area: 0 })).toEqual({ ageGroup: '32', gender: '0' });
    expect(parseOptionBody({ age_group: '32', gender: 1 })).toEqual({ ageGroup: '32', gender: '1' });
  });

  it('option: 객체/배열/임의 문자열/범위 밖 값은 거부', () => {
    expect(parseOptionBody({ age_group: {}, gender: 2 })).toBeNull();
    expect(parseOptionBody({ age_group: 32, gender: 3 })).toBeNull();
    expect(parseOptionBody({ age_group: 32, gender: 'female' })).toBeNull();
    expect(parseOptionBody({ age_group: 32, gender: 2, area: [] })).toBeNull();
    expect(parseOptionBody({ age_group: 32, gender: 2, area: '11&x=1' })).toBeNull();
    expect(parseOptionBody({ gender: 2 })).toBeNull();
    expect(parseOptionBody(undefined)).toBeNull();
  });

  it('option: area는 adm_cd로 전달되고 0이면 빠진다', async () => {
    fakeSgis();
    await call(getDataByOption, { age_group: 32, gender: 2, area: 11 });
    expect(statCalls()[0][1].params).toMatchObject({ adm_cd: '11', age_type: '32', gender: '2' });
    clearCache();
    get.mockClear();
    fakeSgis();
    await call(getDataByOption, { age_group: 32, gender: 2, area: 0 });
    expect(statCalls()[0][1].params.adm_cd).toBeUndefined();
  });
});

describe('L1: 연도 설정', () => {
  it('PUBLIC_DATA_YEARS로 조회 연도를 바꾼다', async () => {
    process.env.PUBLIC_DATA_YEARS = '2022,2023';
    try {
      fakeSgis();
      await call(getDataByKeyword, { people: true });
      expect(statCalls().map(([, cfg]) => cfg.params.year)).toEqual([2022, 2023]);
    } finally {
      delete process.env.PUBLIC_DATA_YEARS;
    }
  });
});
