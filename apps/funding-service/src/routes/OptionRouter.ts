import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import { deleteOption } from '../controller/OptionController';

const router = express.Router();

router.delete('/:id', requireUser, asyncHandler(deleteOption));

export default router;
