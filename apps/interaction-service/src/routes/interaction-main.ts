import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import { interactMain } from '../controller/InteractMainController';

const router = express.Router();

router.get('/', requireUser, asyncHandler(interactMain));

export default router;
