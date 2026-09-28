import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { HttpError, asyncHandler, getUser } from '@shared/config';
import { PaymentInfo } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { parsePaymentInfoBody, requireId, toPaymentInfoDto } from '../modules/validation';

const router = Router();

// 결제 정보 등록
// 참고: 요청의 `token`은 저장하지 않는다. PG 연동(결제 실행 주체, 빌링키 암호화 저장)이 정해질 때까지 받지도 요구하지도 않는다.
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const input = parsePaymentInfoBody(req.body);

    const repo = AppDataSource.getRepository(PaymentInfo);
    const saved = await repo.save(repo.create({ userId, ...input }));

    res.status(StatusCodes.CREATED).json({ insertedId: saved.id });
  })
);

// 결제 정보 삭제
// 예약에 연결된 결제 수단은 실제로 지우지 않고 비활성화한다. (지우면 예약이 결제 수단을 잃어 조회·취소가 깨진다)
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const id = requireId(req.params.id, '잘못된 결제 수단 ID입니다.');

    const repo = AppDataSource.getRepository(PaymentInfo);
    if (!(await repo.exists({ where: { id, userId } }))) {
      throw new HttpError(StatusCodes.NOT_FOUND, '결제 수단을 찾을 수 없습니다.');
    }

    const [{ used }] = await AppDataSource.query('SELECT COUNT(*) AS used FROM payment_schedule WHERE payment_info_id = ?', [id]);
    if (Number(used) > 0) {
      await repo.update({ id, userId }, { isActive: false, isPrimary: false });
    } else {
      await repo.delete({ id, userId });
    }

    res.status(StatusCodes.OK).json({ message: '결제정보가 정상적으로 삭제되었습니다.' });
  })
);

// 결제 정보 전체 조회
router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const { userId } = getUser(res);

    const list = await AppDataSource.getRepository(PaymentInfo).find({
      where: { userId, isActive: true },
      order: { createdAt: 'DESC' },
    });

    res.status(StatusCodes.OK).json({ data: list.map(toPaymentInfoDto) });
  })
);

// 결제 정보 조회
router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const { userId } = getUser(res);
    const id = requireId(req.params.id, '잘못된 결제 수단 ID입니다.');

    const item = await AppDataSource.getRepository(PaymentInfo).findOneBy({ id, userId, isActive: true });
    if (!item) {
      throw new HttpError(StatusCodes.NOT_FOUND, '결제 수단을 찾을 수 없습니다.');
    }

    res.status(StatusCodes.OK).json({ data: toPaymentInfoDto(item) });
  })
);

export default router;
