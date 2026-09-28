import { SelectQueryBuilder } from 'typeorm';
import { Project } from '@shared/entities';
import { ProjectStatus } from './validation';

/**
 * 후원자 수와 좋아요 수는 조인이 아니라 서브쿼리로 센다.
 * (payment_schedule과 like를 함께 LEFT JOIN하면 행이 곱해져서 후원 수가 좋아요 수만큼 부풀려진다)
 */
export const SPONSOR_COUNT = '(SELECT COUNT(DISTINCT s.user_id) FROM payment_schedule s WHERE s.project_id = project.project_id)';
export const LIKE_COUNT = '(SELECT COUNT(*) FROM `like` l WHERE l.project_id = project.project_id)';

export const ACHIEVEMENT = 'COALESCE(FLOOR(project.current_amount / NULLIF(project.goal_amount, 0) * 100), 0)';
/** 종료일까지 남은 일수. 종료 후에는 0 */
export const REMAINING_DAY = 'GREATEST(DATEDIFF(project.end_date, CURDATE()), 0)';

/** 프로젝트 진행 상태는 저장된 컬럼(is_active)이 아니라 날짜로 계산한다. */
const STATUS_CONDITION: Record<ProjectStatus, string | null> = {
  ongoing: 'project.start_date <= CURDATE() AND project.end_date >= CURDATE()',
  upcoming: 'project.start_date > CURDATE()',
  ended: 'project.end_date < CURDATE()',
  open: 'project.end_date >= CURDATE()',
  all: null,
};

export const whereStatus = (query: SelectQueryBuilder<Project>, status: ProjectStatus) => {
  const condition = STATUS_CONDITION[status];
  return condition ? query.andWhere(condition) : query;
};

/** 목록 공통 응답 컬럼 */
export const listColumns = (query: SelectQueryBuilder<Project>) =>
  query
    .select([
      'project.projectId AS project_id',
      'project.image_url AS image_url',
      'project.title AS title',
      'project.shortDescription AS short_description',
      'project.goalAmount AS goal_amount',
      'project.currentAmount AS current_amount',
    ])
    .addSelect(ACHIEVEMENT, 'achievement')
    .addSelect(REMAINING_DAY, 'remaining_day');

type Raw = Record<string, unknown>;

/** 집계 결과는 문자열로 올 수 있어 숫자로 바꿔 내려준다. */
export const withNumbers = <T extends Raw>(row: T): T => {
  const out: Raw = { ...row };
  for (const key of ['achievement', 'remaining_day', 'current_amount', 'goal_amount', 'sponsor', 'likes', 'like_count', 'created_before']) {
    if (key in out && out[key] !== null && out[key] !== undefined) out[key] = Number(out[key]);
  }
  return out as T;
};
