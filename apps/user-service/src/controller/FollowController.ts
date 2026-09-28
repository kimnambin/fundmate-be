import { Request, Response } from 'express';
import StatusCode from 'http-status-codes';
import { HttpError, getUser, parsePaging } from '@shared/config';
import { Follow, User } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { requireId } from '../modules/validation';

const isDuplicate = (err: unknown) =>
  ((err as { code?: string; driverError?: { code?: string } })?.driverError?.code ??
    (err as { code?: string })?.code) === 'ER_DUP_ENTRY';

export const addFollow = async (req: Request, res: Response) => {
  const { userId: followerId } = getUser(res);
  // 문자열 "12"도 숫자로 바꾼 뒤 비교해야 자기 자신 팔로우 검사를 우회할 수 없다.
  const followingId = requireId(req.body?.following_id, '팔로우할 유저 ID 필요');

  if (followerId === followingId) {
    throw new HttpError(StatusCode.BAD_REQUEST, '자기 자신 팔로우 불가');
  }

  if (!(await AppDataSource.getRepository(User).exists({ where: { userId: followingId } }))) {
    throw new HttpError(StatusCode.NOT_FOUND, '존재하지 않는 유저');
  }

  const followRepo = AppDataSource.getRepository(Follow);
  if (await followRepo.exists({ where: { followerId, followingId } })) {
    throw new HttpError(StatusCode.CONFLICT, '이미 팔로우한 유저');
  }

  try {
    await followRepo.insert({ followerId, followingId });
  } catch (err) {
    // 동시에 같은 요청이 와서 조회 후 삽입 사이에 다른 요청이 먼저 저장한 경우
    if (isDuplicate(err)) throw new HttpError(StatusCode.CONFLICT, '이미 팔로우한 유저');
    throw err;
  }

  res.status(StatusCode.CREATED).json({ message: '팔로우 성공' });
};

export const deleteFollow = async (req: Request, res: Response) => {
  const { userId: followerId } = getUser(res);
  const followingId = requireId(req.body?.following_id, '팔로우 취소할 유저 ID 필요');

  if (followerId === followingId) {
    throw new HttpError(StatusCode.BAD_REQUEST, '자기 자신 언팔로우 불가');
  }

  if (!(await AppDataSource.getRepository(User).exists({ where: { userId: followingId } }))) {
    throw new HttpError(StatusCode.NOT_FOUND, '존재하지 않는 유저');
  }

  const result = await AppDataSource.getRepository(Follow).delete({ followerId, followingId });
  if (!result.affected) {
    throw new HttpError(StatusCode.NOT_FOUND, '팔로우하지 않은 유저');
  }

  res.status(StatusCode.OK).json({ message: '팔로우 취소 성공' });
};

/** 팔로잉/팔로워 목록 공통: 상대 사용자의 공개 필드만 조회한다. (비밀번호 해시 등을 읽지 않음) */
const listFollows = async (req: Request, res: Response, side: 'following' | 'follower') => {
  const { userId } = getUser(res);
  const { limit, offset } = parsePaging(req.query);
  const isFollowing = side === 'following';

  const [rows, total] = await AppDataSource.getRepository(Follow).findAndCount({
    where: isFollowing ? { followerId: userId } : { followingId: userId },
    relations: { [side]: { image: true } },
    select: {
      followerId: true,
      followingId: true,
      [side]: { userId: true, nickname: true, image: { imageId: true, url: true } },
    },
    order: isFollowing ? { followingId: 'DESC' } : { followerId: 'DESC' },
    skip: offset,
    take: limit,
  });

  const list = rows.map((row) => {
    const other = row[side];
    return {
      userId: other.userId,
      nickname: other.nickname,
      imageId: other.image?.imageId ?? null,
      imageUrl: other.image?.url ?? null,
    };
  });

  res.status(StatusCode.OK).json({ total, [side]: list });
};

export const getMyFollowing = (req: Request, res: Response) => listFollows(req, res, 'following');

export const getMyFollower = (req: Request, res: Response) => listFollows(req, res, 'follower');
