import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { DeepPartial } from 'typeorm';
import { HttpError, asyncHandler, getUser } from '@shared/config';
import { OptionData, PaymentHistory, PaymentInfo, PaymentSchedule, Project } from '@shared/entities';
import { AppDataSource } from '../data-source';
import {
  MAX_AMOUNT,
  addDays,
  kstDate,
  kstMidnight,
  optionalAmount,
  parseAddress,
  parsePaymentInfoBody,
  requireAmount,
  requireId,
  todayKst,
} from '../modules/validation';

const router = Router();

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const bad = (message: string) => new HttpError(StatusCodes.BAD_REQUEST, message);

/** 결제 예정일 하루 전부터는 예약 내용을 바꿀 수 없다. */
const assertEditable = (schedule: PaymentSchedule) => {
  if (schedule.executed) {
    throw new HttpError(StatusCodes.CONFLICT, '이미 결제가 실행된 예약입니다.');
  }
  const msUntilPayment = schedule.scheduleDate.getTime() - Date.now();
  if (msUntilPayment <= ONE_DAY_MS) {
    throw new HttpError(StatusCodes.FORBIDDEN, '결제 예정일 하루 전부터는 결제 정보를 수정할 수 없습니다.');
  }
};

/** `date` 컬럼은 문자열('YYYY-MM-DD') 또는 Date로 온다. */
const dateOf = (value: unknown): string => (typeof value === 'string' ? value.slice(0, 10) : kstDate(value as Date));

// 펀딩 결제 및 예약 내역 전체 조회 (예약이 없으면 빈 목록)
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const { userId } = getUser(res);

    const [schedules, count] = await AppDataSource.getRepository(PaymentSchedule).findAndCount({
      where: { userId },
      relations: ['project', 'option'],
      order: { createdAt: 'DESC', id: 'DESC' },
    });

    // 프로젝트가 삭제되었거나(project = null) 옵션이 없는 예약도 목록에서 빠지지 않는다.
    const data = schedules.map((schedule) => ({
      scheduleId: schedule.id,
      productImage: schedule.project?.imageUrl ?? null,
      productName: schedule.project?.title ?? null,
      optionName: schedule.option?.title ?? null,
      totalAmount: schedule.totalAmount,
      scheduleDate: schedule.scheduleDate,
      createdAt: schedule.createdAt,
    }));

    res.status(StatusCodes.OK).json({ data, count });
  })
);

// 펀딩 결제 및 예약 내역 상세 조회
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const reservationId = requireId(req.params.id, '잘못된 예약 ID입니다.');

    const schedule = await AppDataSource.getRepository(PaymentSchedule).findOne({
      where: { id: reservationId, userId },
      relations: ['project', 'option', 'paymentInfo'],
    });
    if (!schedule) {
      throw new HttpError(StatusCodes.NOT_FOUND, '이미 취소되었거나 존재하지 않는 예약입니다.');
    }

    res.status(StatusCodes.OK).json({
      id: schedule.id,
      userId: schedule.userId,
      rewardId: schedule.option?.optionId ?? null,
      paymentInfoId: schedule.paymentInfo?.id ?? null,
      productImage: schedule.project?.imageUrl ?? null,
      productName: schedule.project?.title ?? null,
      optionName: schedule.option?.title ?? null,
      optionAmount: schedule.option?.price ?? null,
      amount: schedule.amount,
      donateAmount: schedule.donateAmount ?? null,
      totalAmount: schedule.totalAmount,
      scheduleDate: schedule.scheduleDate,
      executed: schedule.executed,
      createdAt: schedule.createdAt,
      address: schedule.address ?? null,
      addressNumber: schedule.addressNumber ?? null,
      addressInfo: schedule.addressInfo ?? null,
      retryCount: schedule.retryCount,
      lastErrorMessage: schedule.lastErrorMessage ?? null,
    });
  })
);

// 펀딩 결제 및 예약 등록
// 금액은 서버가 계산한다. 클라이언트가 보낸 rewardAmount / totalAmount는 서버 계산값과 맞는지 대조하는 데만 쓴다.
// 결제 예정일도 서버가 정한다. (프로젝트 종료일 다음 날)
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const paymentInfoId = requireId(body.paymentInfoId, '결제 수단 ID가 올바르지 않습니다.');
    const projectId = requireId(body.projectId, '프로젝트 ID가 올바르지 않습니다.');
    const rewardId = body.rewardId === undefined || body.rewardId === null ? undefined : requireId(body.rewardId, '옵션 ID가 올바르지 않습니다.');
    const amount = requireAmount(body.amount, '후원 금액(amount)');
    const donateAmount = optionalAmount(body.donateAmount, '추가 후원금(donateAmount)') ?? 0;
    const clientRewardAmount = optionalAmount(body.rewardAmount, '리워드 금액(rewardAmount)');
    const clientTotalAmount = optionalAmount(body.totalAmount, '총 금액(totalAmount)');
    const address = parseAddress(body);

    const insertedId = await AppDataSource.transaction(async (manager) => {
      // 내 결제 수단만 사용할 수 있다.
      const paymentInfo = await manager.findOneBy(PaymentInfo, { id: paymentInfoId, userId });
      if (!paymentInfo || paymentInfo.isActive === false) throw bad('유효하지 않은 결제 수단 ID입니다.');

      const project = await manager.findOne(Project, {
        where: { projectId },
        relations: { user: true },
        select: { projectId: true, startDate: true, endDate: true, user: { userId: true } },
      });
      if (!project) throw bad('유효하지 않은 프로젝트 ID입니다.');
      if (project.user?.userId === userId) {
        throw new HttpError(StatusCodes.FORBIDDEN, '자신의 프로젝트에는 후원할 수 없습니다.');
      }

      const today = todayKst();
      const startDate = dateOf(project.startDate);
      const endDate = dateOf(project.endDate);
      if (today < startDate || today > endDate) throw bad('진행 중인 프로젝트만 후원할 수 있습니다.');

      // 옵션은 이 프로젝트의 것이어야 한다.
      let rewardPrice = 0;
      let option: OptionData | null = null;
      if (rewardId !== undefined) {
        option = await manager.findOne(OptionData, { where: { optionId: rewardId, project: { projectId } } });
        if (!option) throw bad('유효하지 않은 옵션 ID입니다.');
        rewardPrice = option.price;
      }
      // 옵션을 골랐다면 클라이언트가 보낸 리워드 금액은 서버가 조회한 가격과 같아야 한다.
      if (option && clientRewardAmount !== undefined && clientRewardAmount !== rewardPrice) {
        throw bad('리워드 금액이 맞지 않습니다.');
      }

      const totalAmount = rewardPrice + donateAmount + amount;
      if (totalAmount <= 0 || totalAmount > MAX_AMOUNT) throw bad('총 금액이 올바르지 않습니다.');
      if (clientTotalAmount !== undefined && clientTotalAmount !== totalAmount) throw bad('금액이 맞지 않습니다.');

      // 같은 프로젝트에 중복 예약(더블 클릭 등)을 막는다.
      if (await manager.exists(PaymentSchedule, { where: { userId, project: { projectId } } })) {
        throw new HttpError(StatusCodes.CONFLICT, '이미 후원 예약한 프로젝트입니다.');
      }

      const saved = await manager.save(
        manager.create(PaymentSchedule, {
          userId,
          option: option ? { optionId: option.optionId } : undefined,
          paymentInfo: { id: paymentInfoId },
          project: { projectId },
          donateAmount,
          amount,
          totalAmount,
          scheduleDate: kstMidnight(addDays(endDate, 1)),
          ...address,
        } as DeepPartial<PaymentSchedule>)
      );
      return saved.id;
    });

    res.status(StatusCodes.CREATED).json({ insertedId });
  })
);

// 펀딩 결제 및 예약 정보 수정 (리워드, 추가 후원금, 배송지). 어떤 필드를 바꿔도 총액은 항상 다시 계산한다.
router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const reservationId = requireId(req.params.id, '잘못된 예약 ID입니다.');
    const body = (req.body ?? {}) as Record<string, unknown>;

    // 결제일은 서버가 정하므로 scheduleDate는 받지 않는다.
    const rewardId = body.rewardId === undefined || body.rewardId === null ? body.rewardId : requireId(body.rewardId, '옵션 ID가 올바르지 않습니다.');
    const donateAmount = body.donateAmount === null ? 0 : optionalAmount(body.donateAmount, '추가 후원금(donateAmount)');
    const address = parseAddress(body);

    await AppDataSource.transaction(async (manager) => {
      const schedule = await manager.findOne(PaymentSchedule, {
        where: { id: reservationId, userId },
        relations: ['option', 'paymentInfo', 'project'],
      });
      if (!schedule) throw new HttpError(StatusCodes.NOT_FOUND, '예약된 정보가 없습니다.');
      assertEditable(schedule);

      if (rewardId === null) {
        // TypeORM에서 관계를 비우려면 undefined(변경 없음)가 아니라 null이어야 한다.
        schedule.option = null as unknown as undefined;
      } else if (rewardId !== undefined) {
        if (!schedule.project) throw new HttpError(StatusCodes.CONFLICT, '삭제된 프로젝트의 예약은 수정할 수 없습니다.');
        const option = await manager.findOne(OptionData, {
          where: { optionId: rewardId as number, project: { projectId: schedule.project.projectId } },
        });
        if (!option) throw bad('유효하지 않은 옵션 ID입니다.');
        schedule.option = option;
      }
      if (donateAmount !== undefined) schedule.donateAmount = donateAmount;

      const totalAmount = schedule.amount + (schedule.option?.price ?? 0) + (schedule.donateAmount ?? 0);
      if (totalAmount <= 0 || totalAmount > MAX_AMOUNT) throw bad('총 금액이 올바르지 않습니다.');
      schedule.totalAmount = totalAmount;

      if (address.address !== undefined) schedule.address = address.address;
      if (address.addressNumber !== undefined) schedule.addressNumber = address.addressNumber;
      if (address.addressInfo !== undefined) schedule.addressInfo = address.addressInfo;

      await manager.save(schedule);
    });

    res.status(StatusCodes.OK).json({ message: '펀딩 정보가 정상적으로 수정되었습니다.' });
  })
);

// 예약에 연결된 결제 수단 수정 (내 결제 수단만)
router.put(
  '/:id/payment_info',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const reservationId = requireId(req.params.id, '잘못된 예약 ID입니다.');
    const input = parsePaymentInfoBody(req.body);

    await AppDataSource.transaction(async (manager) => {
      const reservation = await manager.findOne(PaymentSchedule, {
        where: { id: reservationId, userId },
        relations: ['paymentInfo'],
      });
      if (!reservation) throw new HttpError(StatusCodes.NOT_FOUND, '예약된 정보가 없습니다.');
      assertEditable(reservation);

      // 예약에 연결된 결제 수단이 요청자의 것인지 다시 확인한다. (남의 결제 수단을 덮어쓰지 못하게)
      const paymentInfo = reservation.paymentInfo
        ? await manager.findOneBy(PaymentInfo, { id: reservation.paymentInfo.id, userId })
        : null;
      if (!paymentInfo) throw new HttpError(StatusCodes.NOT_FOUND, '연결된 결제수단을 찾을 수 없습니다.');

      await manager.update(PaymentInfo, { id: paymentInfo.id, userId }, input);
    });

    res.status(StatusCodes.OK).json({ message: '결제정보가 정상적으로 수정되었습니다.' });
  })
);

// 펀딩 결제 예약 취소: 이력에 취소로 남기고 예약을 삭제한다. 이미 실행된 예약이나 종료된 프로젝트의 예약은 취소할 수 없다.
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const reservationId = requireId(req.params.id, '잘못된 예약 ID입니다.');

    await AppDataSource.transaction(async (manager) => {
      const schedule = await manager.findOne(PaymentSchedule, {
        where: { id: reservationId, userId },
        relations: ['option', 'project', 'paymentInfo'],
      });
      if (!schedule) throw new HttpError(StatusCodes.NOT_FOUND, '예약된 정보가 없습니다.');

      if (schedule.executed) {
        throw new HttpError(StatusCodes.CONFLICT, '이미 결제가 실행된 예약은 취소할 수 없습니다.');
      }
      if (schedule.project && dateOf(schedule.project.endDate) < todayKst()) {
        throw new HttpError(StatusCodes.CONFLICT, '종료된 프로젝트의 예약은 취소할 수 없습니다.');
      }

      // 결제 수단이나 프로젝트가 삭제된 예약도 취소할 수 있어야 하므로 모든 관계를 null 안전하게 읽는다.
      const history = manager.getRepository(PaymentHistory).create({
        userId,
        scheduleId: schedule.id,
        paymentInfoId: schedule.paymentInfo?.id ?? null,
        paymentMethod: schedule.paymentInfo?.method ?? 'UNKNOWN',
        bankCode: schedule.paymentInfo?.code ?? null,
        displayInfo: schedule.paymentInfo?.displayInfo ?? null,
        rewardId: schedule.option?.optionId ?? null,
        projectId: schedule.project?.projectId ?? null,
        optionTitle: schedule.option?.title,
        optionAmount: schedule.option?.price,
        project: schedule.project ?? undefined,
        projectTitle: schedule.project?.title ?? null,
        projectImage: schedule.project?.imageUrl ?? null,
        amount: schedule.amount,
        donateAmount: schedule.donateAmount ?? null,
        totalAmount: schedule.totalAmount,
        address: schedule.address ?? null,
        addressNumber: schedule.addressNumber ?? null,
        addressInfo: schedule.addressInfo ?? null,
        executedAt: new Date(),
        status: 'cancel',
        createdAt: schedule.createdAt,
        errorLog: schedule.lastErrorMessage ?? null,
      } as unknown as DeepPartial<PaymentHistory>);
      await manager.save(history);
      await manager.remove(schedule);
    });

    res.status(StatusCodes.OK).json({ message: '예약이 취소되었습니다.' });
  })
);

export default router;
