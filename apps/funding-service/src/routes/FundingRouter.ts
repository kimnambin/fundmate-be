import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import { createFundingAndOption, getFundingDetail } from '../controller/FundingController';

const router = express.Router();

router.post('/', requireUser, asyncHandler(createFundingAndOption));
router.get('/:id', asyncHandler(getFundingDetail));

export default router;
