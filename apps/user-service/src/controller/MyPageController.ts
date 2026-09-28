import { Request, Response } from 'express';
import { EntityManager } from 'typeorm';
import StatusCode from 'http-status-codes';
import { HttpError, WindowCounter, getUser, parsePaging, serviceClients, verifyPassword } from '@shared/config';
import { Age, Category, Follow, Image, InterestCategory, Token, User } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { downstream, orEmpty } from '../modules/downstream';
import { parseDateParam, parseProfileBody, parseProjectIds } from '../modules/validation';

const WITHDRAWN_NICKNAME = '탈퇴한 사용자';

/** 회원 탈퇴 재확인 실패 횟수 (탈취한 세션으로 비밀번호를 대입하는 것을 막음) */
const WITHDRAW_MAX_FAILURES = 5;
const withdrawFailures = new WindowCounter(15 * 60 * 1000);

const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.COOKIE_SECURE === 'true',
  sameSite: 'lax' as const,
  path: '/',
});

const countOf = async (manager: EntityManager, sql: string, params: unknown[]): Promise<number> => {
  const rows = await manager.query(sql, params);
  return Number(rows?.[0]?.count ?? 0);
};

/**
 * 회원 탈퇴.
 * - 비밀번호 계정은 비밀번호로, 소셜 계정(비밀번호 없음)은 가입 이메일을 다시 입력해 재확인한다.
 * - 진행 중인 프로젝트(메이커)나 아직 실행되지 않은 결제 예정(후원자)이 있으면 거부한다.
 * - 프로젝트, 댓글, 결제 내역이 함께 사라지지 않도록 사용자 행은 지우지 않고 익명화한다.
 *   개인정보(이메일, 비밀번호, 프로필, 결제 수단)와 로그인 수단(토큰)은 삭제한다.
 */
export const deleteUser = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const key = String(userId);

  if (withdrawFailures.count(key) >= WITHDRAW_MAX_FAILURES) {
    throw new HttpError(StatusCode.TOO_MANY_REQUESTS, '확인 시도 횟수를 초과했습니다. 잠시 후 다시 시도해 주세요.');
  }

  const user = await AppDataSource.getRepository(User).findOne({
    where: { userId },
    // password, salt는 기본 조회에서 제외되어 있으므로 명시적으로 읽는다.
    select: { userId: true, email: true, password: true, salt: true },
  });
  if (!user) {
    throw new HttpError(StatusCode.NOT_FOUND, '존재하지 않는 유저');
  }

  const { password, email } = (req.body ?? {}) as Record<string, unknown>;
  const denied = () => {
    withdrawFailures.hit(key);
    return new HttpError(StatusCode.UNAUTHORIZED, user.password ? '비밀번호 불일치' : '이메일 불일치');
  };

  if (user.password && user.salt) {
    if (typeof password !== 'string' || password === '') {
      throw new HttpError(StatusCode.BAD_REQUEST, '비밀번호 필요');
    }
    if (password.length > 1024 || !(await verifyPassword(password, user)).valid) throw denied();
  } else {
    if (typeof email !== 'string' || email === '') {
      throw new HttpError(StatusCode.BAD_REQUEST, '가입한 이메일을 입력해 주세요.');
    }
    if (email.trim().toLowerCase() !== (user.email ?? '').toLowerCase()) throw denied();
  }

  await AppDataSource.transaction(async (manager) => {
    const ongoingProjects = await countOf(
      manager,
      'SELECT COUNT(*) AS count FROM project WHERE user_id = ? AND end_date >= CURDATE()',
      [userId]
    );
    if (ongoingProjects > 0) {
      throw new HttpError(
        StatusCode.CONFLICT,
        '진행 중인 프로젝트가 있어 탈퇴할 수 없습니다. 프로젝트가 종료된 뒤 다시 시도해 주세요.'
      );
    }
    const pendingPayments = await countOf(
      manager,
      'SELECT COUNT(*) AS count FROM payment_schedule WHERE user_id = ? AND executed = 0 AND schedule_date >= NOW()',
      [userId]
    );
    if (pendingPayments > 0) {
      throw new HttpError(
        StatusCode.CONFLICT,
        '결제 예정인 후원이 있어 탈퇴할 수 없습니다. 예약을 취소한 뒤 다시 시도해 주세요.'
      );
    }

    // 로그인 수단과 개인 정보 삭제
    await manager.createQueryBuilder().delete().from(Token).where('user_id = :userId', { userId }).execute();
    await manager.createQueryBuilder().delete().from(InterestCategory).where('user_id = :userId', { userId }).execute();
    await manager.delete(Follow, { followerId: userId });
    await manager.delete(Follow, { followingId: userId });
    await manager.query('DELETE FROM `like` WHERE user_id = ?', [userId]);
    await manager.query('DELETE FROM payment_info WHERE user_id = ?', [userId]);

    // 사용자 행은 남기고 식별 정보를 지운다. (email은 unique이므로 사용자별로 다른 값을 둔다)
    await manager.update(
      User,
      { userId },
      {
        nickname: WITHDRAWN_NICKNAME,
        email: () => `CONCAT('deleted-', user_id, '@deleted.invalid')`,
        password: null,
        salt: null,
        contents: null,
        gender: null,
        image: null,
        age: null,
        provider: null,
        snsId: null,
      } as never
    );
  });

  withdrawFailures.reset(key);
  res.clearCookie('accessToken', cookieOptions());
  res.clearCookie('refreshToken', cookieOptions());
  res.status(StatusCode.OK).json({ message: '회원 탈퇴 성공' });
};

export const getMyPage = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const projectIds = parseProjectIds(req.query.project_id);

  const followRepo = AppDataSource.getRepository(Follow);
  const auth = { userId };

  // 서비스 세 곳과 DB를 병렬로 조회하고, 실패한 항목만 비워서 내려준다.
  const [following, follower, funding, payment, interaction] = await Promise.allSettled([
    followRepo.count({ where: { followerId: userId } }),
    followRepo.count({ where: { followingId: userId } }),
    projectIds.length > 0
      ? downstream(serviceClients['funding-service'].withAuth(auth).get('/api/projects/recent', { project_id: projectIds }))
      : Promise.resolve({ data: [] }),
    downstream(serviceClients['payment-service'].withAuth(auth).get('/statistics/count')),
    downstream(serviceClients['interaction-service'].withAuth(auth).get('/interactionmain')),
  ]);

  const degraded: string[] = [];
  const pick = <T, F = T>(result: PromiseSettledResult<T>, name: string, fallback: F): T | F => {
    if (result.status === 'fulfilled') return result.value;
    degraded.push(name);
    console.error(`마이 페이지 ${name} 조회 실패: ${(result.reason as Error).message}`);
    return fallback;
  };

  const interactionData = pick(interaction, 'interaction', { data: { likeCount: 0, commentCount: 0 } }).data;
  const payload = {
    followingCount: pick(following, 'following', 0),
    followerCount: pick(follower, 'follower', 0),
    paymentCount: pick(payment, 'payment', { data: { count: 0 } }).data.count ?? 0,
    likeCount: interactionData.likeCount ?? 0,
    commentCount: interactionData.commentCount ?? 0,
    fundingGetList: pick(funding, 'funding', { data: [] }).data,
  };

  res.status(StatusCode.OK).json(degraded.length > 0 ? { ...payload, degraded: [...new Set(degraded)] } : payload);
};

export const getMyProfile = async (_req: Request, res: Response) => {
  const { userId } = getUser(res);

  const user = await AppDataSource.getRepository(User).findOne({
    where: { userId },
    relations: { age: true, image: true },
  });
  if (!user) {
    throw new HttpError(StatusCode.NOT_FOUND, '존재하지 않는 유저');
  }

  const interestCategory = await AppDataSource.getRepository(InterestCategory).findOne({
    where: { user: { userId } },
    relations: { category: true },
  });

  res.status(StatusCode.OK).json({
    userId: user.userId,
    nickname: user.nickname,
    gender: user.gender,
    ageId: user.age?.ageId ?? null,
    generation: user.age?.generation ?? null,
    email: user.email,
    contents: user.contents,
    imageId: user.image?.imageId ?? null,
    imageUrl: user.image?.url ?? null,
    // 프로필 수정 API가 받는 값(categories 테이블의 ID)과 같은 값을 내려준다.
    interestCategory: interestCategory?.category?.categoryId ?? null,
    categoryId: interestCategory?.category?.categoryId ?? null,
    categoryName: interestCategory?.category?.name ?? null,
  });
};

export const updateMyProfile = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const input = parseProfileBody(req.body);

  // 하나라도 실패하면 아무것도 저장되지 않도록 한 트랜잭션으로 처리한다.
  await AppDataSource.transaction(async (manager) => {
    const user = await manager.findOne(User, { where: { userId }, relations: { image: true, age: true } });
    if (!user) {
      throw new HttpError(StatusCode.NOT_FOUND, '존재하지 않는 유저');
    }

    if (input.nickname !== undefined) user.nickname = input.nickname;
    if (input.gender !== undefined) user.gender = input.gender as string;
    if (input.contents !== undefined) user.contents = input.contents as string;

    if (input.imageUrl === null) {
      user.image = null;
    } else if (input.imageUrl !== undefined) {
      user.image =
        (await manager.findOne(Image, { where: { url: input.imageUrl } })) ??
        (await manager.save(manager.create(Image, { url: input.imageUrl })));
    }

    if (input.ageId !== undefined) {
      const age = await manager.findOne(Age, { where: { ageId: input.ageId } });
      if (!age) throw new HttpError(StatusCode.BAD_REQUEST, '연령 정보 없음');
      user.age = age;
    }
    await manager.save(user);

    if (input.categoryId !== undefined) {
      const category = await manager.findOne(Category, { where: { categoryId: input.categoryId } });
      if (!category) throw new HttpError(StatusCode.BAD_REQUEST, '카테고리 정보 없음');

      // 소셜 가입 사용자는 관심 카테고리 행이 없으므로 없으면 만든다.
      const existing = await manager.findOne(InterestCategory, { where: { user: { userId } } });
      if (existing) {
        existing.category = category;
        await manager.save(existing);
      } else {
        await manager.save(InterestCategory, { user: { userId } as User, category });
      }
    }
  });

  res.status(StatusCode.OK).json({ message: '내 프로필 수정 완료' });
};

export const getMySupportedProjects = async (_req: Request, res: Response) => {
  const { userId } = getUser(res);

  // 예약이 없으면 payment-service가 404를 준다. 목록은 비어 있는 것으로 취급한다.
  const result = await downstream(
    orEmpty(serviceClients['payment-service'].withAuth({ userId }).get('/reservations'), { data: [] })
  );
  res.status(StatusCode.OK).json(result.data);
};

export const getMyComments = async (req: Request, res: Response) => {
  const { userId } = getUser(res);

  // page, limit를 둘 다 보낸 경우에만 페이지네이션을 적용한다. (기존 동작 유지)
  const paging = req.query.page !== undefined && req.query.limit !== undefined ? parsePaging(req.query) : undefined;

  const result = await downstream(
    serviceClients['funding-service']
      .withAuth({ userId })
      .get('/profiles/my-comments', paging ? { page: paging.page, limit: paging.limit } : undefined)
  );
  res.status(StatusCode.OK).json(result.data);
};

export const getMyCreatedProjects = async (_req: Request, res: Response) => {
  const { userId } = getUser(res);
  const funding = serviceClients['funding-service'].withAuth({ userId });

  const [completed, list] = await Promise.all([
    downstream(funding.get('/profiles/recent-completed')),
    downstream(funding.get('/profiles/my-projects')),
  ]);

  res.status(StatusCode.OK).json({ completedFunding: completed.data, fundingList: list.data });
};

export const getMyProjectStatistics = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  // 이 API의 파라미터는 start/end, payment-service는 startDate/endDate를 받는다.
  const startDate = parseDateParam(req.query.start);
  const endDate = parseDateParam(req.query.end);

  const [funding, payment] = await Promise.all([
    downstream(serviceClients['funding-service'].withAuth({ userId }).get(`/profiles/${userId}`)),
    downstream(serviceClients['payment-service'].withAuth({ userId }).get('/statistics/summary', { startDate, endDate })),
  ]);

  res.status(StatusCode.OK).json({
    fundingCount: Array.isArray(funding.data) ? funding.data.length : 0,
    statistic: payment.data,
  });
};

export const getMyProjectPayments = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const { page, limit } = parsePaging(req.query, 10, 100);

  const result = await downstream(
    serviceClients['payment-service'].withAuth({ userId }).get('/statistics/history', { page, limit })
  );
  res.status(StatusCode.OK).json(result.data);
};
