import { HttpError, isAllowedImageUrl, parseId } from '@shared/config';

const bad = (message: string) => new HttpError(400, message);

export const TITLE_MAX = 30;
export const SHORT_DESCRIPTION_MAX = 45;
export const DESCRIPTION_MAX = 20000;
export const OPTION_TITLE_MAX = 30;
export const OPTION_DESCRIPTION_MAX = 150;
export const MAX_OPTIONS = 20;
/** MySQL INT 상한 */
export const MAX_INT = 2_147_483_647;

export const requireId = (value: unknown, message: string): number => {
  const id = parseId(value);
  if (id === null) throw bad(message);
  return id;
};

const requireText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || value.trim() === '') throw bad(`${label}을(를) 입력하세요.`);
  const text = value.trim();
  if (text.length > max) throw bad(`${label}은(는) ${max}자 이하여야 합니다.`);
  return text;
};

const requireInt = (value: unknown, label: string, min: number, max = MAX_INT): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw bad(`${label}은(는) ${min} 이상 ${max} 이하의 정수여야 합니다.`);
  }
  return value;
};

/** 한국 시간 기준 오늘 (YYYY-MM-DD) */
export const todayKst = (now = Date.now()): string => new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

const requireDate = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad(`${label}은(는) YYYY-MM-DD 형식이어야 합니다.`);
  // 2026-02-31 같은 존재하지 않는 날짜를 거른다.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw bad(`${label}이(가) 올바른 날짜가 아닙니다.`);
  }
  return value;
};

export interface OptionInput {
  title: string;
  description: string;
  price: number;
}

export interface ProjectInput {
  imageUrl: string;
  categoryId: number;
  title: string;
  goalAmount: number;
  startDate: string;
  endDate: string;
  deliveryDate: string;
  shortDescription: string;
  description: string;
  options: OptionInput[];
  gender: number;
  ageGroup: number;
}

/** POST /projects 본문 검증. 잘못된 값은 DB 오류(500)가 아니라 400으로 돌려준다. */
export const parseProjectBody = (body: unknown, today = todayKst()): ProjectInput => {
  const b = (body ?? {}) as Record<string, unknown>;

  if (typeof b.image_url !== 'string' || !isAllowedImageUrl(b.image_url)) throw bad('허용되지 않는 이미지 주소입니다.');

  const startDate = requireDate(b.start_date, '시작일');
  const endDate = requireDate(b.end_date, '종료일');
  const deliveryDate = requireDate(b.delivery_date, '배송일');
  if (startDate < today) throw bad('시작일은 오늘 이후여야 합니다.');
  if (endDate < startDate) throw bad('종료일은 시작일 이후여야 합니다.');
  if (deliveryDate < endDate) throw bad('배송일은 종료일 이후여야 합니다.');

  if (!Array.isArray(b.options) || b.options.length === 0 || b.options.length > MAX_OPTIONS) {
    throw bad(`옵션은 1개 이상 ${MAX_OPTIONS}개 이하로 입력하세요.`);
  }
  const options = b.options.map((raw, index): OptionInput => {
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      title: requireText(o.title, `옵션 ${index + 1}의 제목`, OPTION_TITLE_MAX),
      description: requireText(o.description, `옵션 ${index + 1}의 설명`, OPTION_DESCRIPTION_MAX),
      price: requireInt(o.price, `옵션 ${index + 1}의 가격`, 0),
    };
  });

  return {
    imageUrl: b.image_url,
    categoryId: requireId(b.category_id, '카테고리 정보가 올바르지 않습니다.'),
    title: requireText(b.title, '제목', TITLE_MAX),
    goalAmount: requireInt(b.goal_amount, '목표 금액', 1),
    startDate,
    endDate,
    deliveryDate,
    shortDescription: requireText(b.short_description, '짧은 설명', SHORT_DESCRIPTION_MAX),
    description: requireText(b.description, '설명', DESCRIPTION_MAX),
    options,
    // 타깃 성별/연령대. 보내지 않으면 전체(0)
    gender: b.gender === undefined ? 0 : requireInt(b.gender, '성별', 0, 9),
    ageGroup: b.age_group === undefined ? 0 : requireInt(b.age_group, '연령대', 0, 99),
  };
};

/** `?project_id=1&project_id=2`, `?project_id=1,2,3` 모두 허용. 최대 `max`개 */
export const parseProjectIds = (value: unknown, max = 20): number[] => {
  const raw = (Array.isArray(value) ? value : [value]).flatMap((v) => (typeof v === 'string' ? v.split(',') : []));
  const ids = raw.map((v) => parseId(v.trim())).filter((v): v is number => v !== null);
  return [...new Set(ids)].slice(0, max);
};

export type ProjectStatus = 'open' | 'ongoing' | 'upcoming' | 'ended' | 'all';
const STATUSES: ProjectStatus[] = ['open', 'ongoing', 'upcoming', 'ended', 'all'];

/** `?status=` : 기본값은 종료되지 않은 프로젝트(open = 진행 중 + 시작 전) */
export const parseStatus = (value: unknown, fallback: ProjectStatus = 'open'): ProjectStatus => {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !STATUSES.includes(value as ProjectStatus)) {
    throw bad(`status는 ${STATUSES.join(', ')} 중 하나여야 합니다.`);
  }
  return value as ProjectStatus;
};
