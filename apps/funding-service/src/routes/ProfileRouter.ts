import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import {
  getFundingComments,
  getMyFundingList,
  getMyFundingRecentlyFinished,
  getOthersFundingList,
} from '../controller/ProfileController';
const router = express.Router();

// 내 정보(my-*, recent-completed)는 로그인 필수, 다른 회원의 프로젝트 목록(:id)은 공개
router.get('/recent-completed', requireUser, asyncHandler(getMyFundingRecentlyFinished));
router.get('/my-projects', requireUser, asyncHandler(getMyFundingList));
router.get('/my-comments', requireUser, asyncHandler(getFundingComments));
router.get('/:id', asyncHandler(getOthersFundingList));

export default router;
