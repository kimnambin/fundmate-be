import crypto from 'crypto';
import { Request, Response } from 'express';
import { In } from 'typeorm';
import StatusCode from 'http-status-codes';
import {
  HttpError,
  getUser,
  hashPassword,
  isValidPasswordFormat,
  spendVerifyTime,
  verifyPassword,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  refreshTokenKeys,
} from '@shared/config';
import { EmailVerification, InterestCategory, Token, User } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { ACCESS_TOKEN_TTL_MS, cookieOptions } from '../modules/cookies';
import {
  CODE_SEND_HOURLY_MAX,
  CODE_VERIFY_MAX_FAILURES,
  LOGIN_MAX_FAILURES,
  codeSendCooldown,
  codeSendHourly,
  codeVerifyFailures,
  loginFailures,
} from '../modules/limits';
import { sendVerificationMail } from '../modules/mailer';
import {
  clearTokenCookies,
  issueTokens,
  signAccessToken,
  verifyRefreshToken,
} from '../modules/tokens';
import {
  dbErrorCode,
  requireCode,
  requireEmail,
  requireNickname,
  requirePositiveInt,
} from '../modules/validation';

/** 코드 발급 후 인증 전 유효 시간 */
const CODE_TTL_MS = 5 * 60 * 1000;
/** 인증에 성공한 뒤 가입/비밀번호 재설정을 마쳐야 하는 시간 */
const VERIFIED_TTL_MS = 30 * 60 * 1000;

const tooMany = (message: string) => new HttpError(StatusCode.TOO_MANY_REQUESTS, message);

const requireNewPassword = (password: unknown, confirm: unknown): string => {
  if (!isValidPasswordFormat(password)) {
    throw new HttpError(
      StatusCode.BAD_REQUEST,
      `비밀번호는 ${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH}자로 입력해 주세요.`
    );
  }
  if (password !== confirm) {
    throw new HttpError(StatusCode.BAD_REQUEST, '비밀번호 불일치');
  }
  return password;
};

/** 인증에 쓴 기록을 지워 같은 코드로 다시 가입/재설정할 수 없게 한다. */
const consumeVerifications = (email: string) => AppDataSource.getRepository(EmailVerification).delete({ email });

export const sendVerificationCode = async (req: Request, res: Response) => {
  const email = requireEmail(req.body?.email);

  if (codeSendCooldown.count(email) >= 1) {
    throw tooMany('인증 코드는 1분 후에 다시 요청할 수 있습니다.');
  }
  if (codeSendHourly.count(email) >= CODE_SEND_HOURLY_MAX) {
    throw tooMany('인증 코드 요청 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.');
  }
  codeSendCooldown.hit(email);
  codeSendHourly.hit(email);

  const code = crypto.randomInt(100000, 1000000).toString(); // 6자리
  const verificationRepo = AppDataSource.getRepository(EmailVerification);

  await verificationRepo.update({ email, isUsed: false }, { expiresAt: new Date() });
  const record = await verificationRepo.save(
    verificationRepo.create({ email, code, expiresAt: new Date(Date.now() + CODE_TTL_MS) })
  );

  try {
    await sendVerificationMail(email, code);
  } catch (err) {
    // 발송에 실패한 코드는 쓸 수 없게 만든다.
    await verificationRepo.update({ verificationId: record.verificationId }, { expiresAt: new Date() });
    console.error('인증 메일 발송 실패:', (err as Error).message);
    throw new HttpError(StatusCode.INTERNAL_SERVER_ERROR, '이메일 인증 코드 전송 실패');
  }

  res.status(StatusCode.OK).json({ message: '이메일 인증 코드 전송 완료' });
};

export const verifyEmailCode = async (req: Request, res: Response) => {
  const email = requireEmail(req.body?.email);
  const code = requireCode(req.body?.code);

  const verificationRepo = AppDataSource.getRepository(EmailVerification);

  if (codeVerifyFailures.count(email) >= CODE_VERIFY_MAX_FAILURES) {
    // 무차별 대입 방지: 실패가 한도를 넘으면 진행 중인 코드를 모두 무효화한다.
    await verificationRepo.update({ email, isUsed: false }, { expiresAt: new Date() });
    throw tooMany('인증 시도 횟수를 초과했습니다. 인증 코드를 다시 요청해 주세요.');
  }

  const record = await verificationRepo.findOne({
    where: { email, code, isUsed: false },
    order: { verificationId: 'DESC' },
  });

  if (!record) {
    codeVerifyFailures.hit(email);
    throw new HttpError(StatusCode.BAD_REQUEST, '잘못된 인증 코드');
  }
  if (new Date() > record.expiresAt) {
    throw new HttpError(StatusCode.GONE, '인증 코드 만료');
  }

  // 인증에 성공한 시점부터 가입/재설정을 마칠 시간을 따로 준다.
  record.isUsed = true;
  record.expiresAt = new Date(Date.now() + VERIFIED_TTL_MS);
  await verificationRepo.save(record);
  codeVerifyFailures.reset(email);

  res.status(StatusCode.OK).json({ message: '이메일 인증 성공' });
};

export const signUp = async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const nickname = requireNickname(body.nickname);
  const email = requireEmail(body.email);
  const code = requireCode(body.code);
  const password = requireNewPassword(body.password, body.confirm_password);
  const categoryId = requirePositiveInt(body.category_id, '관심 카테고리를 선택해 주세요.');

  const record = await AppDataSource.getRepository(EmailVerification).findOne({
    where: { email, code, isUsed: true },
    order: { verificationId: 'DESC' },
  });
  if (!record) {
    throw new HttpError(StatusCode.BAD_REQUEST, '이메일 인증 필요');
  }
  if (new Date() > record.expiresAt) {
    throw new HttpError(StatusCode.GONE, '인증 코드 만료');
  }

  const hashed = await hashPassword(password);

  try {
    // 사용자와 관심 카테고리는 함께 저장되거나 함께 취소된다.
    await AppDataSource.transaction(async (manager) => {
      if (await manager.exists(User, { where: { email } })) {
        throw new HttpError(StatusCode.CONFLICT, '이미 가입된 이메일');
      }
      const user = await manager.save(manager.create(User, { nickname, email, ...hashed }));
      await manager.save(InterestCategory, { user, category: { categoryId } });
    });
  } catch (err) {
    const dbCode = dbErrorCode(err);
    if (dbCode === 'ER_DUP_ENTRY') throw new HttpError(StatusCode.CONFLICT, '이미 가입된 이메일');
    if (dbCode === 'ER_NO_REFERENCED_ROW_2') throw new HttpError(StatusCode.BAD_REQUEST, '존재하지 않는 카테고리');
    throw err;
  }

  await consumeVerifications(email);
  res.status(StatusCode.CREATED).json({ message: '회원 가입 성공' });
};

export const login = async (req: Request, res: Response) => {
  const { email: rawEmail, password } = req.body ?? {};

  if (typeof rawEmail !== 'string' || typeof password !== 'string' || !rawEmail || !password) {
    throw new HttpError(StatusCode.BAD_REQUEST, '이메일 및 비밀번호 입력 필요');
  }
  const email = rawEmail.trim();
  const invalid = new HttpError(StatusCode.UNAUTHORIZED, '잘못된 이메일 또는 비밀번호');

  if (loginFailures.count(email) >= LOGIN_MAX_FAILURES) {
    throw tooMany('로그인 시도 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.');
  }
  // 비정상적으로 긴 입력으로 해시 계산을 시키는 것을 막는다.
  if (password.length > 1024 || email.length > 100) {
    loginFailures.hit(email.slice(0, 100));
    throw invalid;
  }

  const userRepo = AppDataSource.getRepository(User);
  // password, salt는 기본 조회에서 제외되어 있으므로 명시적으로 읽는다.
  const user = await userRepo.findOne({
    where: { email },
    select: { userId: true, email: true, nickname: true, password: true, salt: true },
  });

  if (!user || !user.password || !user.salt) {
    // 계정이 없거나 소셜 전용 계정이어도 같은 시간을 쓴다. (응답 시간으로 계정 존재 여부를 알 수 없게)
    await spendVerifyTime(password);
    loginFailures.hit(email);
    throw invalid;
  }

  const { valid, needsRehash } = await verifyPassword(password, user);
  if (!valid) {
    loginFailures.hit(email);
    throw invalid;
  }
  loginFailures.reset(email);

  if (needsRehash) {
    // 기존 해시(10,000회)로 로그인한 사용자는 새 방식으로 바꿔 둔다. 실패해도 로그인은 진행한다.
    try {
      await userRepo.update({ userId: user.userId }, await hashPassword(password));
    } catch (err) {
      console.error('비밀번호 재해시 실패:', (err as Error).message);
    }
  }

  await issueTokens(user, res);
  res.status(StatusCode.OK).json({ nickname: user.nickname });
};

export const refreshAccessToken = async (req: Request, res: Response) => {
  const refreshToken = req.header('x-refresh-token');

  if (!refreshToken) {
    throw new HttpError(StatusCode.UNAUTHORIZED, '리프레시 토큰 필요');
  }

  let payload: { userId: number };
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    // 만료/위조는 서버 오류가 아니라 "다시 로그인"이다.
    throw new HttpError(StatusCode.UNAUTHORIZED, '유효하지 않은 리프레시 토큰');
  }

  const tokenRecord = await AppDataSource.getRepository(Token).findOne({
    where: { refreshToken: In(refreshTokenKeys(refreshToken)), revoke: false },
    relations: { user: true },
  });

  if (!tokenRecord || tokenRecord.user.userId !== payload.userId || tokenRecord.expiresAt < new Date()) {
    throw new HttpError(StatusCode.UNAUTHORIZED, '유효하지 않은 리프레시 토큰');
  }

  // 로그인 때와 같이 email을 유지해야 게이트웨이가 x-user-email을 계속 전달할 수 있다.
  const accessToken = signAccessToken(tokenRecord.user);
  res.cookie('accessToken', accessToken, cookieOptions(ACCESS_TOKEN_TTL_MS));

  res.status(StatusCode.OK).json({ message: '토큰 갱신 완료' });
};

export const resetPassword = async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const email = requireEmail(body.email);
  const code = requireCode(body.code);
  const newPassword = requireNewPassword(body.new_password, body.confirm_password);

  const record = await AppDataSource.getRepository(EmailVerification).findOne({
    where: { email, code, isUsed: true },
    order: { verificationId: 'DESC' },
  });
  if (!record) {
    throw new HttpError(StatusCode.BAD_REQUEST, '이메일 인증 필요');
  }
  if (new Date() > record.expiresAt) {
    throw new HttpError(StatusCode.GONE, '인증 코드 만료');
  }

  const hashed = await hashPassword(newPassword);
  const userRepo = AppDataSource.getRepository(User);
  const user = await userRepo.findOne({ where: { email }, select: { userId: true } });

  // 존재하지 않는 이메일에도 같은 응답을 준다. (계정 존재 여부 노출 방지)
  if (user) {
    await userRepo.update({ userId: user.userId }, hashed);
    // 비밀번호를 바꾸면 기존 세션(리프레시 토큰)은 모두 폐기한다.
    await AppDataSource.getRepository(Token)
      .createQueryBuilder()
      .update()
      .set({ revoke: true })
      .where('user_id = :userId', { userId: user.userId })
      .execute();
  }

  await consumeVerifications(email);
  res.status(StatusCode.OK).json({ message: '비밀번호 재설정 성공' });
};

export const logout = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const refreshToken = req.header('x-refresh-token');

  if (!refreshToken) {
    throw new HttpError(StatusCode.UNAUTHORIZED, '리프레시 토큰 필요');
  }

  await AppDataSource.getRepository(Token)
    .createQueryBuilder()
    .update()
    .set({ revoke: true })
    .where('user_id = :userId AND refresh_token IN (:...keys) AND revoke = false', {
      userId,
      keys: refreshTokenKeys(refreshToken),
    })
    .execute();

  clearTokenCookies(res);
  res.status(StatusCode.OK).json({ message: '로그아웃 성공' });
};
