import { KEYWORDS, Keyword } from './SgisConfig';

function isInValid(element: unknown): boolean {
  return (
    element === undefined ||
    element === null ||
    (typeof element === 'string' && element.trim() === '') ||
    (Array.isArray(element) && element.length === 0)
  );
}

export const requestBodyValidation = (datas: unknown[]): boolean => {
  const hasInvalid = datas.some(isInValid);
  return !hasInvalid;
};

/** 숫자(또는 숫자 문자열)만 허용. 객체/배열/임의 문자열은 SGIS 쿼리로 넘기지 않는다. */
const toCode = (value: unknown, pattern: RegExp): string | undefined => {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    value = String(value);
  }
  return typeof value === 'string' && pattern.test(value) ? value : undefined;
};

export interface OptionQuery {
  ageGroup: string;
  gender: string;
  /** 전국이면 undefined */
  area?: string;
}

/** SGIS 성별 코드: 0 전체, 1 남자, 2 여자 */
const GENDER = /^[012]$/;
const AGE_GROUP = /^\d{1,3}$/;
const AREA = /^\d{1,5}$/;

export const parseOptionBody = (body: unknown): OptionQuery | null => {
  const { age_group, gender, area } = (body ?? {}) as Record<string, unknown>;

  const ageGroup = toCode(age_group, AGE_GROUP);
  const genderCode = toCode(gender, GENDER);
  if (ageGroup === undefined || genderCode === undefined) return null;

  // 전국: 값이 없거나 빈 문자열 / 0
  if (area === undefined || area === null || area === '' || area === 0 || area === '0') {
    return { ageGroup, gender: genderCode };
  }
  const areaCode = toCode(area, AREA);
  if (areaCode === undefined) return null;
  return { ageGroup, gender: genderCode, area: areaCode };
};

/**
 * 키워드는 boolean만 허용하고, 빠진 키워드는 선택하지 않은 것으로 본다.
 * 하나도 선택하지 않았거나 boolean이 아닌 값이 있으면 null.
 */
export const parseKeywordBody = (body: unknown): Keyword[] | null => {
  const source = (body ?? {}) as Record<string, unknown>;
  const selected: Keyword[] = [];

  for (const keyword of KEYWORDS) {
    const value = source[keyword];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return null;
    if (value) selected.push(keyword);
  }
  return selected.length > 0 ? selected : null;
};
