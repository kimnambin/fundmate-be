import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { getUser, parsePaging } from '@shared/config';
import { Comment, Project } from '@shared/entities';
import { Equal } from 'typeorm';
import { AppDataSource } from '../data-source';
import { ACHIEVEMENT, REMAINING_DAY, SPONSOR_COUNT, whereStatus, withNumbers } from '../modules/projectQuery';
import { requireId } from '../modules/validation';

const projects = () => AppDataSource.getRepository(Project).createQueryBuilder('project');

// 마이페이지 - 최근 완료된 펀딩 (종료일이 지난 내 프로젝트를 최근 종료순으로)
export const getMyFundingRecentlyFinished = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const { limit } = parsePaging(req.query, 10, 50);

  const query = projects()
    .select([
      'project.projectId AS project_id',
      'project.image_url AS image_url',
      'project.title AS project_title',
      'DATE(project.start_date) AS start_date',
      'DATE(project.end_date) AS end_date',
      'project.currentAmount AS current_amount',
    ])
    .addSelect(ACHIEVEMENT, 'achievement')
    // 프로젝트마다 한 행. 후원자 수는 서브쿼리로 센다.
    .addSelect(SPONSOR_COUNT, 'sponsor')
    .where('project.user_id = :userId', { userId });
  whereStatus(query, 'ended');

  const rows = await query.orderBy('project.end_date', 'DESC').addOrderBy('project.project_id', 'DESC').limit(limit).getRawMany();
  res.status(StatusCodes.OK).json(rows.map(withNumbers));
};

const projectListOf = (userId: number) =>
  projects()
    .select([
      'project.projectId AS project_id',
      'project.image_url AS image_url',
      'project.title AS project_title',
      'project.short_description AS short_description',
      'project.current_amount AS current_amount',
    ])
    .addSelect(ACHIEVEMENT, 'achievement')
    .addSelect(REMAINING_DAY, 'remaining_day')
    .where('project.user_id = :userId', { userId })
    .orderBy('project.project_id', 'DESC');

// 마이페이지 - 내가 올린 펀딩 목록
export const getMyFundingList = async (_req: Request, res: Response) => {
  const { userId } = getUser(res);
  const rows = await projectListOf(userId).getRawMany();
  res.status(StatusCodes.OK).json(rows.map(withNumbers));
};

// 다른 회원 - 타 회원이 올린 펀딩 목록
export const getOthersFundingList = async (req: Request, res: Response) => {
  const userId = requireId(req.params.id, '잘못된 유저 ID');
  const rows = await projectListOf(userId).getRawMany();
  res.status(StatusCodes.OK).json(rows.map(withNumbers));
};

// 펀딩 후기: SQL에서 페이지를 자른다. (전부 읽은 뒤 메모리에서 자르지 않음)
export const getFundingComments = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const { page, limit, offset } = parsePaging(req.query, 10, 50);

  const totalItems = await AppDataSource.getRepository(Comment).count({ where: { userId: Equal(userId) as never } });

  const data =
    totalItems === 0
      ? []
      : await projects()
          .innerJoin('project.comments', 'comment')
          .select([
            'project.projectId AS project_id',
            'project.image_url AS image_url',
            'project.title AS title',
            'comment.content AS content',
          ])
          .where('comment.user_id = :userId', { userId })
          .orderBy('comment.created_at', 'DESC')
          .addOrderBy('comment.comment_id', 'DESC')
          .limit(limit)
          .offset(offset)
          .getRawMany();

  res.status(StatusCodes.OK).json({
    meta: { totalItems, totalPages: Math.ceil(totalItems / limit), currentPage: page, limit },
    data,
  });
};
