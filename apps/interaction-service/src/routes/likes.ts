import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import { addLike, removeLike, myLikeList } from '../controller/LikeController';

const router = express.Router();

router.use(requireUser);
router.post('/:id', asyncHandler(addLike));
router.delete('/:id', asyncHandler(removeLike));
router.get('/', asyncHandler(myLikeList));

export default router;
