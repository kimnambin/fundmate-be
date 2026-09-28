import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { HttpError, getUser } from '@shared/config';
import { Category, OptionData, Project } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { addLikedStatusToQuery } from '../modules/addLikedStatus';
import { LIKE_COUNT, SPONSOR_COUNT } from '../modules/projectQuery';
import { parseProjectBody, requireId, todayKst } from '../modules/validation';

// 프로젝트 생성 (프로젝트 + 옵션을 한 트랜잭션으로)
export const createFundingAndOption = async (req: Request, res: Response) => {
  const { userId } = getUser(res);
  const input = parseProjectBody(req.body);

  // 연결과 트랜잭션 시작도 try 안에서 처리해서, 실패해도 예외가 밖으로 새거나 연결이 남지 않게 한다.
  const queryRunner = AppDataSource.createQueryRunner();
  try {
    await queryRunner.connect();
    await queryRunner.startTransaction();

    if (!(await queryRunner.manager.exists(Category, { where: { categoryId: input.categoryId } }))) {
      throw new HttpError(StatusCodes.BAD_REQUEST, '존재하지 않는 카테고리입니다.');
    }

    const project = await queryRunner.manager.save(
      queryRunner.manager.create(Project, {
        imageUrl: input.imageUrl,
        user: { userId },
        category: { categoryId: input.categoryId },
        goalAmount: input.goalAmount,
        currentAmount: 0,
        title: input.title,
        startDate: input.startDate as unknown as Date,
        endDate: input.endDate as unknown as Date,
        deliveryDate: input.deliveryDate as unknown as Date,
        shortDescription: input.shortDescription,
        description: input.description,
        // 진행 상태는 조회 시 날짜로 계산한다. 컬럼은 기존 값과의 호환을 위해 채워 둔다.
        isActive: input.startDate <= todayKst(),
        gender: input.gender,
        ageGroup: input.ageGroup,
      })
    );

    if (!project.projectId) {
      throw new Error('프로젝트 생성 실패');
    }

    await queryRunner.manager.save(
      input.options.map((option) =>
        queryRunner.manager.create(OptionData, { ...option, project: { projectId: project.projectId } })
      )
    );

    await queryRunner.commitTransaction();
    res.status(StatusCodes.CREATED).json({ project_id: project.projectId });
  } catch (err) {
    if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
    throw err;
  } finally {
    await queryRunner.release();
  }
};

// 프로젝트 상세 조회
export const getFundingDetail = async (req: Request, res: Response) => {
  const projectId = requireId(req.params.id, '잘못된 프로젝트 ID 값입니다.');
  const userId: number | undefined = res.locals.user?.userId;

  // 후원자/좋아요 수는 서브쿼리로 세므로 조인 곱셈이 없고, 프로젝트가 없으면 행이 없다.
  const projectQuery = addLikedStatusToQuery(
    userId,
    AppDataSource.getRepository(Project)
      .createQueryBuilder('project')
      .leftJoin('project.user', 'user')
      .select([
        'project.projectId AS project_id',
        'project.image_url AS project_image_url',
        'project.title AS title',
        'project.current_amount AS current_price',
        'GREATEST(DATEDIFF(project.end_date, CURDATE()), 0) AS remaining_day',
        'project.goalAmount AS goal_amount',
        'DATE(project.start_date) AS start_date',
        'DATE(project.end_date) AS end_date',
        'DATE(project.delivery_date) AS delivery_date',
        'project.description AS description',
        'user.image_id AS user_image_id',
        'user.nickname AS nickname',
        'user.contents AS content',
        'DATE_ADD(project.end_date, INTERVAL 1 DAY) AS payment_date',
      ])
      .addSelect(SPONSOR_COUNT, 'sponsor')
      .addSelect(LIKE_COUNT, 'likes')
      .where('project.projectId = :projectId', { projectId })
  );

  const optionQuery = AppDataSource.getRepository(OptionData)
    .createQueryBuilder('option')
    .select(['option.title AS title', 'option.description AS description', 'option.price AS price'])
    .where('option.project_id = :projectId', { projectId })
    .orderBy('option.option_id', 'ASC');

  const [projectRow, optionRows] = await Promise.all([projectQuery.getRawOne(), optionQuery.getRawMany()]);

  if (!projectRow) {
    throw new HttpError(StatusCodes.NOT_FOUND, '프로젝트 정보를 찾을 수 없습니다.');
  }

  res.status(StatusCodes.OK).json({
    project: {
      project_id: projectRow.project_id,
      image_url: projectRow.project_image_url,
      title: projectRow.title,
      current_price: projectRow.current_price,
      remaining_day: Number(projectRow.remaining_day),
      goal_amount: projectRow.goal_amount,
      start_date: projectRow.start_date,
      end_date: projectRow.end_date,
      delivery_date: projectRow.delivery_date,
      description: projectRow.description,
      payment_date: projectRow.payment_date,
      sponsor: Number(projectRow.sponsor),
      likes: Number(projectRow.likes),
      liked: !!Number(projectRow.liked),
    },
    users: {
      image_id: projectRow.user_image_id,
      nickname: projectRow.nickname,
      content: projectRow.content,
    },
    options: optionRows.map((option) => ({ title: option.title, description: option.description, price: option.price })),
  });
};
