import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { HttpError, asyncHandler, getUser, parsePaging, serviceClients } from '@shared/config';
import { PaymentHistory, PaymentSchedule } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { addDays, kstMidnight, parseDateParam } from '../modules/validation';

const router = Router();

const schedules = () => AppDataSource.getRepository(PaymentSchedule).createQueryBuilder('s');
const histories = () => AppDataSource.getRepository(PaymentHistory).createQueryBuilder('h');

/** SUM/COUNT 결과는 문자열로 올 수 있다. */
const num = (value: unknown) => Number(value ?? 0);

// 참고: count / summary / history는 "내가 후원한" 내역(후원자 관점)이다. graph만 "내 프로젝트로 들어온" 후원(메이커 관점)이다.

// 펀딩 전체 갯수
router.get(
  '/count',
  asyncHandler(async (_req: Request, res: Response) => {
    const { userId } = getUser(res);

    const [countBySchedule, countByHistory] = await Promise.all([
      AppDataSource.getRepository(PaymentSchedule).count({ where: { userId } }),
      AppDataSource.getRepository(PaymentHistory).count({ where: { userId, status: 'success' } }),
    ]);

    res.status(StatusCodes.OK).json({ count: countBySchedule + countByHistory, countBySchedule, countByHistory });
  })
);

// 총 후원 금액 및 후원 건수. 예약(아직 결제 전)과 결제 성공 이력을 합산하고, 각각의 금액도 함께 내려준다.
router.get(
  '/summary',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const startDate = parseDateParam(req.query.startDate, 'startDate');
    const endDate = parseDateParam(req.query.endDate, 'endDate');

    if ((startDate === undefined) !== (endDate === undefined)) {
      throw new HttpError(StatusCodes.BAD_REQUEST, '기간은 startDate와 endDate를 함께 보내야 합니다.');
    }
    if (startDate && endDate && startDate > endDate) {
      throw new HttpError(StatusCodes.BAD_REQUEST, 'startDate는 endDate보다 늦을 수 없습니다.');
    }

    // 합계는 DB에서 계산한다.
    const [reserved, paid] = await Promise.all([
      schedules()
        .select('COUNT(*)', 'count')
        .addSelect('COALESCE(SUM(s.total_amount), 0)', 'amount')
        .where('s.user_id = :userId', { userId })
        .getRawOne(),
      histories()
        .select('COUNT(*)', 'count')
        .addSelect('COALESCE(SUM(h.total_amount), 0)', 'amount')
        .where('h.user_id = :userId AND h.status = :status', { userId, status: 'success' })
        .getRawOne(),
    ]);

    const totalAmount = num(reserved?.amount) + num(paid?.amount);
    const totalCount = num(reserved?.count) + num(paid?.count);
    const overall = { totalAmount, totalCount, reservedAmount: num(reserved?.amount), paidAmount: num(paid?.amount) };

    if (!startDate || !endDate) {
      res.status(StatusCodes.OK).json(overall);
      return;
    }

    // 종료일 당일을 포함하고, 날짜는 한국 시간 기준이다.
    const from = kstMidnight(startDate);
    const to = kstMidnight(addDays(endDate, 1));

    const [periodReserved, periodPaid] = await Promise.all([
      schedules()
        .select('COUNT(*)', 'count')
        .addSelect('COALESCE(SUM(s.total_amount), 0)', 'amount')
        .where('s.user_id = :userId AND s.created_at >= :from AND s.created_at < :to', { userId, from, to })
        .getRawOne(),
      histories()
        .select('COUNT(*)', 'count')
        .addSelect('COALESCE(SUM(h.total_amount), 0)', 'amount')
        .where('h.user_id = :userId AND h.status = :status AND h.executed_at >= :from AND h.executed_at < :to', {
          userId,
          status: 'success',
          from,
          to,
        })
        .getRawOne(),
    ]);

    res.status(StatusCodes.OK).json({
      ...overall,
      totalcount: totalCount, // 이전 응답의 키(소문자 c)도 함께 내려 호환을 유지한다.
      period: {
        startDay: startDate,
        endDay: endDate,
        amount: num(periodReserved?.amount) + num(periodPaid?.amount),
        sponsorCount: num(periodPaid?.count),
        checkOut: num(periodReserved?.count),
      },
    });
  })
);

// 결제 내역 리스트: 예약과 이력을 SQL에서 합쳐 정렬하고 LIMIT/OFFSET으로 자른다.
router.get(
  '/history',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const { page, limit, offset } = parsePaging(req.query, 10, 100);

    const [{ total }] = await AppDataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM payment_schedule WHERE user_id = ?) +
         (SELECT COUNT(*) FROM payment_histories WHERE user_id = ?) AS total`,
      [userId, userId]
    );
    const totalItems = num(total);

    const rows: Record<string, unknown>[] =
      totalItems === 0
        ? []
        : await AppDataSource.query(
            `SELECT * FROM (
               SELECT s.id AS scheduleId,
                      p.image_url AS productImage,
                      p.title AS productName,
                      o.title AS optionName,
                      s.schedule_date AS date,
                      s.total_amount AS amount,
                      IF(s.executed, 'success', 'pending') AS status
                 FROM payment_schedule s
                 LEFT JOIN project p ON p.project_id = s.project_id
                 LEFT JOIN option_data o ON o.option_id = s.reward_id
                WHERE s.user_id = ?
               UNION ALL
               SELECT h.schedule_id AS scheduleId,
                      h.project_image AS productImage,
                      h.project_title AS productName,
                      h.option_title AS optionName,
                      COALESCE(h.executed_at, h.created_at) AS date,
                      h.total_amount AS amount,
                      h.status AS status
                 FROM payment_histories h
                WHERE h.user_id = ?
             ) history
             ORDER BY history.date DESC, history.scheduleId DESC
             LIMIT ? OFFSET ?`,
            [userId, userId, limit, offset]
          );

    res.status(StatusCodes.OK).json({
      meta: { totalItems, totalPages: Math.ceil(totalItems / limit), currentPage: page, limit },
      data: rows.map((row) => ({ ...row, optionName: row.optionName ?? null, amount: num(row.amount) })),
    });
  })
);

export interface MyProjectListItem {
  project_id: number;
  image_url: string;
  title: string;
  short_description: string;
  current_amount: number;
  achievement: number;
  remaining_day: number;
}

export interface GraphData {
  x: number;
  y: number;
}

/** `YYYY-MM` (없으면 이번 달, 한국 시간 기준) */
const parseTarget = (value: unknown): { year: number; month: number } => {
  let target: string;
  if (typeof value !== 'string' || value.trim() === '') {
    target = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
  } else {
    target = value;
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(target)) {
    throw new HttpError(StatusCodes.BAD_REQUEST, 'target 형식이 잘못되었습니다. "YYYY-MM" 형태여야 합니다.');
  }
  const [year, month] = target.split('-').map(Number);
  return { year, month };
};

// 통계용 그래프 (메이커 관점: 내 프로젝트로 들어온 후원)
router.get(
  '/graph',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId, email } = getUser(res);
    const { year, month } = parseTarget(req.query.target);

    // 월의 경계를 한국 시간 기준으로 만든다. (프로세스의 로컬 시간대에 의존하지 않음)
    const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
    const nextMonthStart = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
    const from = kstMidnight(monthStart);
    const to = kstMidnight(nextMonthStart);
    const daysInMonth = Math.round((to.getTime() - from.getTime()) / 86400000);

    const meta = { year, month, daysInMonth };

    // 내 프로젝트 목록 (토큰은 넘기지 않는다)
    const projectList = await serviceClients['funding-service']
      .withAuth({ userId, email })
      .get<MyProjectListItem[]>('/profiles/my-projects');
    if (!Array.isArray(projectList.data)) {
      throw new HttpError(StatusCodes.BAD_GATEWAY, '프로젝트 목록을 불러오지 못했습니다.');
    }
    const myFundingIdList = projectList.data.map((p) => p.project_id);

    if (myFundingIdList.length === 0) {
      res.status(StatusCodes.OK).json({
        meta,
        data: [
          { id: 'amount', data: [] },
          { id: 'count', data: [] },
        ],
      });
      return;
    }

    // 컬럼은 한국 시간 값으로 저장되어 있다고 보고(DataSource timezone +09:00) 추가 변환 없이 날짜를 뽑는다.
    const rawHistory = await histories()
      .select('DAY(h.created_at)', 'day')
      .addSelect('COALESCE(SUM(h.total_amount), 0)', 'totalAmount')
      .addSelect('COUNT(DISTINCT h.user_id)', 'sponsorCount')
      .where('h.status = :status', { status: 'success' })
      .andWhere('h.project_id IN (:...ids)', { ids: myFundingIdList })
      .andWhere('h.created_at >= :from AND h.created_at < :to', { from, to })
      .groupBy('day')
      .orderBy('day')
      .getRawMany<{ day: string; totalAmount: string; sponsorCount: string }>();

    const rawSchedule = await schedules()
      .select('DAY(s.created_at)', 'day')
      .addSelect('COALESCE(SUM(s.total_amount), 0)', 'totalAmount')
      // 이력과 같은 단위(그날의 후원자 수)로 센다.
      .addSelect('COUNT(DISTINCT s.user_id)', 'scheduleCount')
      .where('s.executed = :exec', { exec: false })
      .andWhere('s.project_id IN (:...ids)', { ids: myFundingIdList })
      .andWhere('s.created_at >= :from AND s.created_at < :to', { from, to })
      .groupBy('day')
      .orderBy('day')
      .getRawMany<{ day: string; totalAmount: string; scheduleCount: string }>();

    const historyMap = new Map(rawHistory.map((r) => [Number(r.day), r]));
    const scheduleMap = new Map(rawSchedule.map((r) => [Number(r.day), r]));

    const amountData: GraphData[] = [];
    const countData: GraphData[] = [];
    for (let d = 1; d <= daysInMonth; d++) {
      const h = historyMap.get(d);
      const s = scheduleMap.get(d);
      amountData.push({ x: d, y: num(h?.totalAmount) + num(s?.totalAmount) });
      countData.push({ x: d, y: num(h?.sponsorCount) + num(s?.scheduleCount) });
    }

    res.status(StatusCodes.OK).json({
      meta,
      data: [
        { id: 'amount', data: amountData },
        { id: 'count', data: countData },
      ],
    });
  })
);

export default router;
