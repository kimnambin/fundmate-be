import { Request, Response } from 'express';
import { HttpStatusCode } from 'axios';
import { getDataByUrl } from '../modules/GetDataByUrl';
import { parseKeywordBody, parseOptionBody } from '../modules/RequestBodyValidation';
import { cached } from '../modules/ResponseCache';
import { REQUEST_DEADLINE_MS, SGIS_STATS_URL, getYears } from '../modules/SgisConfig';
import { describeError, toHttpStatus } from '../modules/SgisError';

const errorMessage = (status: number) =>
  status === HttpStatusCode.GatewayTimeout
    ? '외부 통계 서비스 응답이 지연되고 있습니다.'
    : status === HttpStatusCode.BadGateway
      ? '외부 통계 서비스 호출에 실패했습니다.'
      : '서버 오류가 발생했습니다.';

const fail = (res: Response, name: string, err: unknown) => {
  console.error(`${name} 내부 오류:`, describeError(err));
  const status = toHttpStatus(err);
  return res.status(status).json({ message: errorMessage(status) });
};

export const getDataByOption = async (req: Request, res: Response) => {
  const query = parseOptionBody(req.body);

  if (!query) {
    return res.status(HttpStatusCode.BadRequest).json({ message: '요청 값이 잘못되었습니다.' });
  }

  try {
    const years = getYears();
    const key = `option:${years.join(',')}:${query.ageGroup}:${query.gender}:${query.area ?? 0}`;

    const result = await cached(key, () => {
      const deadline = Date.now() + REQUEST_DEADLINE_MS;
      return Promise.all(
        years.map((year) =>
          getDataByUrl(
            SGIS_STATS_URL.people,
            { year, gender: query.gender, adm_cd: query.area, age_type: query.ageGroup },
            deadline
          )
        )
      );
    });

    return res.status(HttpStatusCode.Ok).json(result);
  } catch (err) {
    return fail(res, 'getDataByOption', err);
  }
};

export const getDataByKeyword = async (req: Request, res: Response) => {
  const keywords = parseKeywordBody(req.body);

  if (!keywords) {
    return res.status(HttpStatusCode.BadRequest).json({ message: '키워드가 선택되지 않았습니다.' });
  }

  try {
    const years = getYears();
    const result: Record<string, unknown> = {};

    for (const keyword of keywords) {
      result[keyword] = await cached(`keyword:${years.join(',')}:${keyword}`, () => {
        const deadline = Date.now() + REQUEST_DEADLINE_MS;
        return Promise.all(years.map((year) => getDataByUrl(SGIS_STATS_URL[keyword], { year }, deadline)));
      });
    }

    return res.status(HttpStatusCode.Ok).json(result);
  } catch (err) {
    return fail(res, 'getDataByKeyword', err);
  }
};
