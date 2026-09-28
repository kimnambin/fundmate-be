import { WindowCounter } from '@shared/config';

/**
 * 계정 단위 남용 방지 (프로세스 메모리). 게이트웨이의 IP 단위 제한과 별개로 이메일마다 제한한다.
 * 인스턴스가 여러 개면 인스턴스별로 따로 센다.
 */
export const CODE_VERIFY_MAX_FAILURES = 5;
export const codeVerifyFailures = new WindowCounter(5 * 60 * 1000);

/** 같은 이메일로 인증 코드를 보낼 수 있는 간격(1분)과 시간당 횟수 */
export const codeSendCooldown = new WindowCounter(60 * 1000);
export const CODE_SEND_HOURLY_MAX = 5;
export const codeSendHourly = new WindowCounter(60 * 60 * 1000);

export const LOGIN_MAX_FAILURES = 10;
export const loginFailures = new WindowCounter(15 * 60 * 1000);
