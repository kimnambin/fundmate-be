import { Request, Response } from 'express';
import StatusCode from 'http-status-codes';
import { HttpError, serviceClients } from '@shared/config';
import { Follow, User } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { downstream } from '../modules/downstream';
import { requireId } from '../modules/validation';

const loadPublicProfile = async (userId: number) => {
  const user = await AppDataSource.getRepository(User).findOne({
    where: { userId },
    relations: { image: true },
    select: { userId: true, nickname: true, contents: true, image: { imageId: true, url: true } },
  });
  if (!user) {
    throw new HttpError(StatusCode.NOT_FOUND, '존재하지 않는 유저');
  }

  const followRepo = AppDataSource.getRepository(Follow);
  const [followingCount, followerCount] = await Promise.all([
    followRepo.count({ where: { followerId: userId } }),
    followRepo.count({ where: { followingId: userId } }),
  ]);

  return {
    imageId: user.image?.imageId ?? null,
    imageUrl: user.image?.url ?? null,
    nickname: user.nickname,
    contents: user.contents,
    followingCount,
    followerCount,
  };
};

export const getMakerProfile = async (req: Request, res: Response) => {
  const makerId = requireId(req.params.user_id, '잘못된 유저 ID');
  const profile = await loadPublicProfile(makerId);

  // 공개 프로필이므로 로그인 정보 없이 조회한다.
  const funding = await downstream(serviceClients['funding-service'].get(`/profiles/${makerId}`));
  const fundingList = Array.isArray(funding.data) ? funding.data : [];

  res.status(StatusCode.OK).json({ ...profile, fundingCount: fundingList.length, fundingList });
};

/**
 * 서포터 공개 프로필.
 * 후원 건수는 개인 활동 정보라서 본인이 볼 때만 내려준다. (다른 사용자를 대신해 payment-service를 호출하지 않음)
 */
export const getSupporterProfile = async (req: Request, res: Response) => {
  const supporterId = requireId(req.params.user_id, '잘못된 유저 ID');
  const profile = await loadPublicProfile(supporterId);

  let paymentCount: number | null = null;
  const viewerId: number | undefined = res.locals.user?.userId;
  if (viewerId === supporterId) {
    const payment = await downstream(
      serviceClients['payment-service'].withAuth({ userId: viewerId }).get('/statistics/count')
    );
    paymentCount = payment.data.count ?? 0;
  }

  res.status(StatusCode.OK).json({ ...profile, paymentCount });
};
