import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { HttpError, getUser } from '@shared/config';
import { OptionData } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { requireId } from '../modules/validation';

/**
 * 옵션 삭제. 내 프로젝트의 옵션만 지울 수 있고,
 * 프로젝트가 이미 시작되었거나 후원(결제 예정)에 쓰인 옵션은 지울 수 없다.
 * (지우면 후원자의 결제 예정이 리워드 정보를 잃는다)
 */
export const deleteOption = async (req: Request, res: Response) => {
  const optionId = requireId(req.params.id, '잘못된 option id입니다.');
  const { userId } = getUser(res);

  const optionRepo = AppDataSource.getRepository(OptionData);
  const option = await optionRepo.findOne({
    where: { optionId },
    relations: { project: { user: true } },
    select: { optionId: true, project: { projectId: true, user: { userId: true } } },
  });

  if (!option) {
    throw new HttpError(StatusCodes.NOT_FOUND, '옵션을 찾을 수 없습니다.');
  }
  if (option.project?.user?.userId !== userId) {
    throw new HttpError(StatusCodes.FORBIDDEN, '내 프로젝트의 옵션만 삭제할 수 있습니다.');
  }

  const [state] = await AppDataSource.query(
    `SELECT
       (SELECT COUNT(*) FROM payment_schedule WHERE reward_id = ?) AS used,
       (SELECT COUNT(*) FROM project WHERE project_id = ? AND start_date <= CURDATE()) AS started`,
    [optionId, option.project.projectId]
  );
  if (Number(state?.started) > 0) {
    throw new HttpError(StatusCodes.CONFLICT, '이미 시작된 프로젝트의 옵션은 삭제할 수 없습니다.');
  }
  if (Number(state?.used) > 0) {
    throw new HttpError(StatusCodes.CONFLICT, '후원에 사용된 옵션은 삭제할 수 없습니다.');
  }

  await optionRepo.delete({ optionId });
  res.status(StatusCodes.OK).json({ message: '옵션이 삭제되었습니다.' });
};
