import { HttpError } from '@shared/config';

/** 프롬프트에 들어가는 본문의 최대 길이. 한 번의 호출 비용을 제한한다. */
export const MAX_TEXT_LENGTH = 1000;
/** 카테고리, 성별, 나이대 같은 짧은 선택값의 최대 길이 */
export const MAX_LABEL_LENGTH = 30;

const bad = (message: string) => new HttpError(400, message);

// 제어 문자(줄바꿈 포함)를 제외한 일반 문자만 허용한다.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** 구분자 태그를 흉내 내서 프롬프트 구조를 깨는 것을 막는다. */
const stripDelimiter = (text: string) => text.replace(/<\/?\s*user_input\s*>/gi, '');

const requireText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string') throw bad(`${label}을(를) 올바르게 입력해 주세요.`);
  const text = stripDelimiter(value).trim();
  if (text === '') throw bad(`${label}을(를) 입력해 주세요.`);
  if (text.length > max) throw bad(`${label}은(는) ${max}자 이하로 입력해 주세요.`);
  if (CONTROL_CHARS.test(text)) throw bad(`${label}에 사용할 수 없는 문자가 있습니다.`);
  return text;
};

/** 짧은 선택값: 한 줄이어야 하고 줄바꿈으로 규칙을 덮어쓰는 문장을 넣을 수 없다. */
const requireLabel = (value: unknown, label: string): string => {
  const text = requireText(value, label, MAX_LABEL_LENGTH);
  if (/[\r\n]/.test(text)) throw bad(`${label}은(는) 한 줄로 입력해 주세요.`);
  return text;
};

export const parseSummarizeBody = (body: unknown): string => {
  const { message } = (body ?? {}) as Record<string, unknown>;
  return requireText(message, '메시지', MAX_TEXT_LENGTH);
};

export const parseExpandBody = (body: unknown) => {
  const { input_text, category, gender, age_ground } = (body ?? {}) as Record<string, unknown>;
  return {
    inputText: requireText(input_text, '아이디어', MAX_TEXT_LENGTH),
    category: requireLabel(category, '카테고리'),
    gender: requireLabel(gender, '성별'),
    // 요청 필드 이름은 age_ground (기존 API 그대로)
    ageGroup: requireLabel(age_ground, '나이대'),
  };
};
