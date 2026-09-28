import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import { HttpError, getUser, parseId, parsePaging } from '@shared/config';
import { AppDataSource } from '../data-source';
import { Comment, Project, User } from '@shared/entities';

const MAX_COMMENT_LENGTH = 500;

/** 요청 본문에서 댓글 내용을 꺼내 검증한다. (실제 필드는 `contents`, 문서에 있던 `content`도 허용) */
const parseContents = (body: unknown): string => {
  const { contents, content } = (body ?? {}) as Record<string, unknown>;
  const value = contents ?? content;

  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(StatusCodes.BAD_REQUEST, '댓글 내용을 입력해 주세요.');
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new HttpError(StatusCodes.BAD_REQUEST, `댓글은 ${MAX_COMMENT_LENGTH}자 이하로 입력해 주세요.`);
  }
  return trimmed;
};

const requireId = (value: unknown): number => {
  const id = parseId(value);
  if (id === null) throw new HttpError(StatusCodes.BAD_REQUEST, '잘못된 ID입니다.');
  return id;
};

export const addComment = async (req: Request, res: Response): Promise<void> => {
  const projectId = requireId(req.params.id);
  const content = parseContents(req.body);
  const { userId } = getUser(res);

  const projectExists = await AppDataSource.getRepository(Project).exists({ where: { projectId } });
  if (!projectExists) {
    throw new HttpError(StatusCodes.NOT_FOUND, '프로젝트를 찾을 수 없습니다.');
  }

  // 사용자/프로젝트 엔티티를 통째로 불러오지 않고 ID로만 참조한다. (비밀번호 해시가 응답에 섞이지 않게)
  const commentRepo = AppDataSource.getRepository(Comment);
  const saved = await commentRepo.save(
    commentRepo.create({
      userId: { userId } as User,
      project: { projectId } as Project,
      content,
    })
  );

  res.status(StatusCodes.CREATED).json({
    commentId: saved.commentId,
    content: saved.content,
    createdAt: saved.createdAt,
  });
};

export const removeComment = async (req: Request, res: Response): Promise<void> => {
  const commentId = requireId(req.params.id);
  const { userId } = getUser(res);

  const commentRepo = AppDataSource.getRepository(Comment);
  const comment = await commentRepo.findOne({
    where: { commentId },
    relations: { userId: true },
    select: { commentId: true, userId: { userId: true } },
  });

  if (!comment) {
    throw new HttpError(StatusCodes.NOT_FOUND, '댓글을 찾을 수 없습니다.');
  }
  if (comment.userId.userId !== userId) {
    throw new HttpError(StatusCodes.FORBIDDEN, '댓글 삭제 권한이 없습니다.');
  }

  await commentRepo.delete({ commentId });
  res.status(StatusCodes.OK).json({ message: '댓글이 삭제되었습니다.' });
};

export const commentList = async (req: Request, res: Response): Promise<void> => {
  const projectId = requireId(req.params.id);
  const { limit, offset } = parsePaging(req.query);

  const comments = await AppDataSource.getRepository(Comment).find({
    where: { project: { projectId } },
    relations: { userId: { image: true } },
    select: {
      commentId: true,
      content: true,
      createdAt: true,
      // 필요한 컬럼만 읽는다. (password, salt 등을 메모리로 가져오지 않음)
      userId: { userId: true, nickname: true, image: { imageId: true } },
    },
    order: { createdAt: 'DESC', commentId: 'DESC' },
    skip: offset,
    take: limit,
  });

  res.status(StatusCodes.OK).json(
    comments.map((c) => ({
      commentId: c.commentId,
      userId: c.userId.userId,
      nickname: c.userId.nickname,
      imgId: c.userId.image?.imageId,
      content: c.content,
      createdAt: c.createdAt,
    }))
  );
};
