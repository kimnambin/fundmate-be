import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import {
  deleteUser,
  getMyPage,
  getMyProfile,
  updateMyProfile,
  getMySupportedProjects,
  getMyComments,
  getMyCreatedProjects,
  getMyProjectStatistics,
  getMyProjectPayments,
} from '../controller/MyPageController';
import { addFollow, deleteFollow, getMyFollowing, getMyFollower } from '../controller/FollowController';
import { getMakerProfile, getSupporterProfile } from '../controller/UserPageController';

const router = express.Router();

// 공개 프로필만 로그인 없이 접근할 수 있다. 나머지는 게이트웨이 규칙과 무관하게 서비스에서도 막는다.
router.get('/maker/:user_id', asyncHandler(getMakerProfile));
router.get('/supporter/:user_id', asyncHandler(getSupporterProfile));

router.use(['/account', '/mypage', '/projects', '/following'], requireUser);

router.delete('/account', asyncHandler(deleteUser));
router.get('/mypage', asyncHandler(getMyPage));
router.get('/mypage/profile', asyncHandler(getMyProfile));
router.put('/mypage/profile', asyncHandler(updateMyProfile));
router.get('/mypage/payments', asyncHandler(getMySupportedProjects));
router.get('/mypage/comments', asyncHandler(getMyComments));
router.get('/projects', asyncHandler(getMyCreatedProjects));
router.get('/projects/statistics', asyncHandler(getMyProjectStatistics));
router.get('/projects/payments', asyncHandler(getMyProjectPayments));

router.post('/following', asyncHandler(addFollow));
router.delete('/following', asyncHandler(deleteFollow));
router.get('/mypage/following', asyncHandler(getMyFollowing));
router.get('/mypage/follower', asyncHandler(getMyFollower));

export default router;
