import { HttpError, isAllowedImageUrl, parseId } from '@shared/config';

export const NICKNAME_MAX_LENGTH = 45;
export const GENDER_MAX_LENGTH = 5;
export const CONTENTS_MAX_LENGTH = 2000;

const bad = (message: string) => new HttpError(400, message);

/** 양의 정수 ID. 문자열 "12"도 숫자로 변환한다. (엄격 비교가 깨져 자기 자신을 팔로우하는 것을 막음) */
export const requireId = (value: unknown, message: string): number => {
  const id = parseId(value);
  if (id === null) throw bad(message);
  return id;
};

export interface ProfileInput {
  nickname?: string;
  gender?: string | null;
  contents?: string | null;
  /** undefined: 변경 없음, null: 삭제 */
  imageUrl?: string | null;
  ageId?: number;
  categoryId?: number;
}

/** PUT /users/mypage/profile 본문 검증. 보내지 않은 필드는 변경하지 않는다. */
export const parseProfileBody = (body: unknown): ProfileInput => {
  const { nickname, gender, contents, image_url, age_id, category_id } = (body ?? {}) as Record<string, unknown>;
  const input: ProfileInput = {};

  if (nickname !== undefined) {
    if (typeof nickname !== 'string' || nickname.trim() === '' || nickname.trim().length > NICKNAME_MAX_LENGTH) {
      throw bad(`닉네임은 1~${NICKNAME_MAX_LENGTH}자로 입력해 주세요.`);
    }
    input.nickname = nickname.trim();
  }

  if (gender !== undefined) {
    if (gender !== null && (typeof gender !== 'string' || gender.trim().length > GENDER_MAX_LENGTH)) {
      throw bad(`성별은 ${GENDER_MAX_LENGTH}자 이하 문자열이어야 합니다.`);
    }
    input.gender = gender === null ? null : gender.trim();
  }

  if (contents !== undefined) {
    if (contents !== null && (typeof contents !== 'string' || contents.length > CONTENTS_MAX_LENGTH)) {
      throw bad(`자기소개는 ${CONTENTS_MAX_LENGTH}자 이하여야 합니다.`);
    }
    input.contents = contents;
  }

  if (image_url !== undefined) {
    if (image_url !== null && (typeof image_url !== 'string' || !isAllowedImageUrl(image_url))) {
      throw bad('허용되지 않는 이미지 주소입니다.');
    }
    input.imageUrl = image_url;
  }

  if (age_id !== undefined) input.ageId = requireId(age_id, '연령 정보가 올바르지 않습니다.');
  if (category_id !== undefined) input.categoryId = requireId(category_id, '카테고리 정보가 올바르지 않습니다.');

  return input;
};

/** `?project_id=1&project_id=2`, `?project_id=1,2,3` 모두 허용. 최대 `max`개 */
export const parseProjectIds = (value: unknown, max = 20): number[] => {
  const raw = (Array.isArray(value) ? value : [value]).flatMap((v) => (typeof v === 'string' ? v.split(',') : []));
  const ids = raw.map((v) => parseId(v.trim())).filter((v): v is number => v !== null);
  return [...new Set(ids)].slice(0, max);
};

/** `YYYY-MM-DD` 또는 ISO 날짜만 통과 */
export const parseDateParam = (value: unknown): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw bad('날짜 형식이 올바르지 않습니다.');
  }
  return value;
};
