import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { parsePaging } from '@shared/config';
import { Project } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { LIKE_COUNT, listColumns, whereStatus, withNumbers } from '../modules/projectQuery';
import { ProjectStatus, parseProjectIds, parseStatus, requireId } from '../modules/validation';

/** 목록 기본 개수와 최댓값. `limit`, `page` 쿼리로 조절한다. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const projects = () => AppDataSource.getRepository(Project).createQueryBuilder('project');

/** 목록 공통 처리: 상태 필터, 정렬, 페이지네이션 */
const list = async (
  req: Request,
  res: Response,
  options: {
    defaultStatus?: ProjectStatus;
    order: [string, 'ASC' | 'DESC'][];
    extra?: (query: ReturnType<typeof projects>) => void;
    categoryId?: number;
  }
) => {
  const status = parseStatus(req.query.status, options.defaultStatus);
  const { limit, offset } = parsePaging(req.query, DEFAULT_LIMIT, MAX_LIMIT);

  const query = listColumns(projects());
  options.extra?.(query);
  if (options.categoryId !== undefined) {
    query.andWhere('project.category_id = :categoryId', { categoryId: options.categoryId });
  }
  whereStatus(query, status);

  options.order.forEach(([column, direction], index) =>
    index === 0 ? query.orderBy(column, direction) : query.addOrderBy(column, direction)
  );

  // getRawMany에서는 take/skip이 아니라 limit/offset이 SQL에 반영된다.
  const rows = await query.limit(limit).offset(offset).getRawMany();
  res.status(StatusCodes.OK).json(rows.map(withNumbers));
};

// 전체 프로젝트 조회 (메인 화면): 기본은 종료되지 않은 프로젝트, 최신순
export const getAllProjects = (req: Request, res: Response) =>
  list(req, res, { order: [['project.project_id', 'DESC']] });

// 최근 조회한 프로젝트 목록 (입력한 순서 유지)
export const getRecentlyViewedFundingList = async (req: Request, res: Response) => {
  const projectIds = parseProjectIds(req.query.project_id);
  if (projectIds.length === 0) {
    res.status(StatusCodes.OK).json([]);
    return;
  }

  const query = projects()
    .select([
      'project.projectId AS project_id',
      'project.image_url AS imageUrl',
      'project.title AS title',
      'project.shortDescription AS shortDescription',
      'project.goalAmount AS goalAmount',
      'project.currentAmount AS currentAmount',
    ])
    .addSelect('COALESCE(FLOOR(project.current_amount / NULLIF(project.goal_amount, 0) * 100), 0)', 'achievement')
    .addSelect('GREATEST(DATEDIFF(project.end_date, CURDATE()), 0)', 'remainingDay')
    .where('project.projectId IN (:...projectIds)', { projectIds })
    // 조회한 순서(user-service가 보낸 순서)를 유지한다.
    .orderBy('FIELD(project.project_id, :...projectIds)');

  const { limit } = parsePaging(req.query, projectIds.length, 20);
  const rows = await query.limit(limit).getRawMany();
  res.status(StatusCodes.OK).json(
    rows.map((row) => ({
      ...row,
      goalAmount: Number(row.goalAmount),
      currentAmount: Number(row.currentAmount),
      achievement: Number(row.achievement),
      remainingDay: Number(row.remainingDay),
    }))
  );
};

// 마감 임박 프로젝트 목록: 진행 중인 프로젝트를 종료일이 가까운 순으로
export const getDeadlineFundingList = (req: Request, res: Response) =>
  list(req, res, {
    defaultStatus: 'ongoing',
    order: [
      ['project.end_date', 'ASC'],
      ['project.project_id', 'DESC'],
    ],
  });

// 신규 프로젝트 목록
export const getNewFundingList = (req: Request, res: Response) =>
  list(req, res, {
    // 등록 후 지난 일수 (0, 1, 2 ...)
    extra: (query) => query.addSelect('DATEDIFF(CURDATE(), DATE(project.created_at))', 'created_before'),
    order: [
      ['project.created_at', 'DESC'],
      ['project.project_id', 'DESC'],
    ],
  });

// 인기 프로젝트 목록: 진행 중인 프로젝트를 좋아요 수 순으로 (limit 기본 8)
export const getPopularFundingList = async (req: Request, res: Response) => {
  const status = parseStatus(req.query.status, 'ongoing');
  const { limit } = parsePaging(req.query, 8, 50);

  const query = listColumns(projects()).addSelect(LIKE_COUNT, 'like_count');
  whereStatus(query, status);

  const rows = await query.orderBy('like_count', 'DESC').addOrderBy('project.project_id', 'DESC').limit(limit).getRawMany();
  res.status(StatusCodes.OK).json(rows.map(withNumbers));
};

// 카테고리별 프로젝트 목록 (:id 는 카테고리 ID)
export const getFundingListByCategoryId = (req: Request, res: Response) => {
  const categoryId = requireId(req.params.id, '카테고리 ID를 확인해주세요.');
  return list(req, res, { categoryId, order: [['project.project_id', 'DESC']] });
};
