import express from 'express';
import { asyncHandler } from '@shared/config';
import {
  getAllProjects,
  getDeadlineFundingList,
  getFundingListByCategoryId,
  getNewFundingList,
  getPopularFundingList,
  getRecentlyViewedFundingList,
} from '../controller/MainController';

const router = express.Router();

router.get('/', asyncHandler(getAllProjects));
router.get('/recent', asyncHandler(getRecentlyViewedFundingList));
router.get('/deadline', asyncHandler(getDeadlineFundingList));
router.get('/new', asyncHandler(getNewFundingList));
router.get('/popular', asyncHandler(getPopularFundingList));
// 고정 경로(recent, deadline, ...)를 먼저 등록해야 한다. 여기서 :id는 카테고리 ID
router.get('/:id', asyncHandler(getFundingListByCategoryId));

export default router;
