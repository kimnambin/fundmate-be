import { BankCode, PaymentMethod } from '@shared/types';
import { HttpError, parseId } from '@shared/config';

const bad = (message: string) => new HttpError(400, message);

/** MySQL INT 상한. 금액과 합계 모두 이 안에 있어야 한다. */
export const MAX_AMOUNT = 2_000_000_000;
export const ADDRESS_MAX = 255;
export const DISPLAY_INFO_MAX = 255;

export const requireId = (value: unknown, message: string): number => {
  const id = parseId(value);
  if (id === null) throw bad(message);
  return id;
};

/** 금액은 0 이상의 정수만 허용한다. (문자열, 음수, 소수, NaN 거부) */
export const requireAmount = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_AMOUNT) {
    throw bad(`${label}은(는) 0 이상 ${MAX_AMOUNT} 이하의 정수여야 합니다.`);
  }
  return value;
};

export const optionalAmount = (value: unknown, label: string): number | undefined =>
  value === undefined || value === null ? undefined : requireAmount(value, label);

const optionalText = (value: unknown, label: string, max: number): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) throw bad(`${label}은(는) ${max}자 이하의 문자열이어야 합니다.`);
  return value;
};

export interface AddressInput {
  address?: string;
  addressNumber?: number;
  addressInfo?: string;
}

/** 배송지. `addressNumber`(우편번호)는 숫자 또는 숫자 문자열 (컬럼이 INT라서 앞자리 0은 저장되지 않는다) */
export const parseAddress = (body: Record<string, unknown>): AddressInput => {
  const out: AddressInput = {
    address: optionalText(body.address, '주소', ADDRESS_MAX),
    addressInfo: optionalText(body.addressInfo, '상세 주소', ADDRESS_MAX),
  };
  const number = body.addressNumber;
  if (number !== undefined && number !== null) {
    const parsed = typeof number === 'string' && /^\d{1,9}$/.test(number) ? Number(number) : number;
    if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_AMOUNT) {
      throw bad('우편번호가 올바르지 않습니다.');
    }
    out.addressNumber = parsed;
  }
  return out;
};

// --- 결제 수단 ------------------------------------------------------------------

export interface PaymentInfoInput {
  method: PaymentMethod;
  code: BankCode;
  displayInfo: string;
  details: { type: 'card'; expMonth: string; expYear: string } | { type: 'vbank'; owner: string };
}

const CARD_NUMBER = /\d{13,19}/;

/**
 * 결제 수단 입력 검증.
 * `details`는 허용한 필드만 받는다. 카드 번호나 CVC 같은 값이 섞여 들어와도 저장하지 않고 거부한다.
 * (PCI-DSS: 카드 번호 전체는 저장 금지. 화면 표시용 마스킹 값만 `displayInfo`에 둔다)
 */
export const parsePaymentInfoBody = (body: unknown): PaymentInfoInput => {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!Object.values(PaymentMethod).includes(b.method as PaymentMethod)) throw bad('결제 수단 종류가 올바르지 않습니다.');
  if (!Object.values(BankCode).includes(b.code as BankCode)) throw bad('은행 코드가 올바르지 않습니다.');

  if (typeof b.displayInfo !== 'string' || b.displayInfo.trim() === '' || b.displayInfo.length > DISPLAY_INFO_MAX) {
    throw bad('표시 정보(displayInfo)가 올바르지 않습니다.');
  }
  if (CARD_NUMBER.test(b.displayInfo.replace(/[\s-]/g, ''))) {
    throw bad('카드 번호 전체는 보낼 수 없습니다. 마스킹된 값만 보내주세요.');
  }

  const d = b.details;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw bad('결제 수단 상세 정보(details)가 올바르지 않습니다.');
  const details = d as Record<string, unknown>;
  const keys = Object.keys(details).sort().join(',');

  if (details.type === 'card') {
    if (keys !== 'expMonth,expYear,type') throw bad('카드 정보에는 type, expMonth, expYear만 보낼 수 있습니다.');
    if (typeof details.expMonth !== 'string' || !/^(0?[1-9]|1[0-2])$/.test(details.expMonth)) throw bad('만료 월이 올바르지 않습니다.');
    if (typeof details.expYear !== 'string' || !/^(\d{2}|\d{4})$/.test(details.expYear)) throw bad('만료 연도가 올바르지 않습니다.');
    return {
      method: b.method as PaymentMethod,
      code: b.code as BankCode,
      displayInfo: b.displayInfo,
      details: { type: 'card', expMonth: details.expMonth, expYear: details.expYear },
    };
  }

  if (details.type === 'vbank') {
    if (keys !== 'owner,type') throw bad('가상계좌 정보에는 type, owner만 보낼 수 있습니다.');
    if (typeof details.owner !== 'string' || details.owner.trim() === '' || details.owner.length > 50) throw bad('예금주가 올바르지 않습니다.');
    return {
      method: b.method as PaymentMethod,
      code: b.code as BankCode,
      displayInfo: b.displayInfo,
      details: { type: 'vbank', owner: details.owner },
    };
  }

  throw bad('details.type은 card 또는 vbank여야 합니다.');
};

/** 응답용 DTO. 엔티티를 통째로 내리지 않고 화면에 필요한 필드만 내린다. (토큰, 알 수 없는 상세 값 제외) */
export const toPaymentInfoDto = (info: {
  id: number;
  method: string;
  code: string;
  displayInfo: string;
  details: unknown;
  isPrimary?: boolean;
  isActive?: boolean;
  createdAt?: Date;
}) => {
  const d = (info.details ?? {}) as Record<string, unknown>;
  const details =
    d.type === 'card'
      ? { type: 'card', expMonth: d.expMonth, expYear: d.expYear }
      : d.type === 'vbank'
        ? { type: 'vbank', owner: d.owner }
        : {};
  return {
    id: info.id,
    method: info.method,
    code: info.code,
    displayInfo: info.displayInfo,
    details,
    isPrimary: info.isPrimary ?? false,
    isActive: info.isActive ?? true,
    createdAt: info.createdAt,
  };
};

// --- 날짜 -----------------------------------------------------------------------

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 한국 시간 기준 날짜 문자열 (YYYY-MM-DD) */
export const kstDate = (date: Date | string | number): string => new Date(new Date(date).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
export const todayKst = () => kstDate(Date.now());

/** `YYYY-MM-DD`의 한국 시간 00:00 */
export const kstMidnight = (date: string): Date => new Date(`${date}T00:00:00+09:00`);

export const addDays = (date: string, days: number): string =>
  new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

/** `YYYY-MM-DD`만 허용. 없으면 undefined */
export const parseDateParam = (value: unknown, label: string): string | undefined => {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw bad(`${label}은(는) YYYY-MM-DD 형식이어야 합니다.`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw bad(`${label}이(가) 올바른 날짜가 아닙니다.`);
  return value;
};
