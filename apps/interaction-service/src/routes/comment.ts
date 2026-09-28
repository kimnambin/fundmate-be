import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import { addComment, removeComment, commentList } from '../controller/CommentController';

const router = express.Router();

// 목록 조회는 사용자 정보를 쓰지 않는다. (게이트웨이가 로그인을 요구할지는 jwtRules에서 정한다)
router.get('/:id', asyncHandler(commentList));
router.post('/:id', requireUser, asyncHandler(addComment));
router.delete('/:id', requireUser, asyncHandler(removeComment));

export default router;
