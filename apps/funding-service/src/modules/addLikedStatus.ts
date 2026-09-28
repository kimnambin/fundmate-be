import { Project } from '@shared/entities';
import { SelectQueryBuilder } from 'typeorm';

/** 로그인한 사용자가 좋아요했는지(`liked`)를 EXISTS 서브쿼리로 계산한다. 비로그인이면 0. */
export function addLikedStatusToQuery(userId: number | undefined, query: SelectQueryBuilder<Project>) {
  if (userId) {
    query
      .addSelect(
        '(EXISTS (SELECT 1 FROM `like` WHERE `like`.`project_id` = project.projectId AND `like`.`user_id` = :likedUserId))',
        'liked'
      )
      .setParameter('likedUserId', userId);
  } else {
    query.addSelect('0', 'liked');
  }

  return query;
}
