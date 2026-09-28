import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { getUser } from '@shared/config';
import { AppDataSource } from '../data-source';
import { Like, Comment } from '@shared/entities';
import { Equal } from 'typeorm';

export const interactMain = async (_req: Request, res: Response): Promise<void> => {
  const { userId } = getUser(res);

  const likeRepo = AppDataSource.getRepository(Like);
  const commentRepo = AppDataSource.getRepository(Comment);

  const [likeCount, commentCount] = await Promise.all([
    likeRepo.count({ where: { userId } }),
    commentRepo.count({ where: { userId: Equal(userId) } }),
  ]);

  res.status(StatusCodes.OK).json({ likeCount, commentCount });
};
