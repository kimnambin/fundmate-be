import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import {
  sendVerificationCode,
  verifyEmailCode,
  signUp,
  login,
  refreshAccessToken,
  resetPassword,
  logout,
} from '../controller/AuthController';

const router = express.Router();

// IP 단위 제한은 게이트웨이가 맡는다. (서비스는 게이트웨이 뒤에 있어 클라이언트 IP를 알 수 없음)
// 이메일 단위 제한(발송 횟수, 인증/로그인 실패 횟수)은 컨트롤러에 있다.
router.post('/codes/send', asyncHandler(sendVerificationCode));
router.post('/codes/verify', asyncHandler(verifyEmailCode));
router.post('/signup', asyncHandler(signUp));
router.post('/login', asyncHandler(login));
router.post('/token', asyncHandler(refreshAccessToken));
router.patch('/password', asyncHandler(resetPassword));
router.post('/logout', requireUser, asyncHandler(logout));

export default router;
