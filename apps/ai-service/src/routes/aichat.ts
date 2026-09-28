import express from 'express';
import { asyncHandler, requireUser } from '@shared/config';
import { summarize, requests } from '../controller/AiChatController';

const router = express.Router();

// 유료 LLM을 호출하므로 로그인한 사용자만 사용할 수 있다. (게이트웨이 규칙과 무관하게 서비스에서도 막는다)
router.post('/summarize', requireUser, asyncHandler(summarize));
router.post('/requests', requireUser, asyncHandler(requests));

export default router;
