import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { HttpError, getUser, parseId, parsePaging } from '@shared/config';
import { AppDataSource } from '../data-source';
import { Like, Project } from '@shared/entities';

const requireProjectId = (value: unknown): number => {
  const id = parseId(value);
  if (id === null) throw new HttpError(StatusCodes.BAD_REQUEST, '잘못된 프로젝트 ID입니다.');
  return id;
};

// 좋아요 추가
export const addLike = async (req: Request, res: Response): Promise<void> => {
  const projectId = requireProjectId(req.params.id);
  const { userId } = getUser(res);

  const projectExists = await AppDataSource.getRepository(Project).exists({ where: { projectId } });
  if (!projectExists) {
    throw new HttpError(StatusCodes.NOT_FOUND, '프로젝트를 찾을 수 없습니다.');
  }

  const likeRepo = AppDataSource.getRepository(Like);
  await likeRepo.save(likeRepo.create({ userId, projectId }));
  res.status(StatusCodes.OK).json({ message: '좋아요가 추가되었습니다.' });
};

// 좋아요 제거 (이미 없어도 성공으로 응답: 멱등)
export const removeLike = async (req: Request, res: Response): Promise<void> => {
  const projectId = requireProjectId(req.params.id);
  const { userId } = getUser(res);

  await AppDataSource.getRepository(Like).delete({ userId, projectId });
  res.status(StatusCodes.OK).json({ message: '좋아요가 제거되었습니다.' });
};

export const myLikeList = async (req: Request, res: Response): Promise<void> => {
  const { userId } = getUser(res);
  const { limit, offset } = parsePaging(req.query);

  const likes = await AppDataSource.getRepository(Like).find({
    where: { userId },
    relations: { project: true },
    order: { projectId: 'DESC' },
    skip: offset,
    take: limit,
  });

  res.status(StatusCodes.OK).json(
    likes.map((like) => ({
      project_id: like.projectId,
      title: like.project.title,
      img_url: like.project.imageUrl,
      current_amount: like.project.currentAmount,
      goal_amount: like.project.goalAmount,
      description: like.project.description,
    }))
  );
};
