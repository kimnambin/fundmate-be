import crypto from 'crypto';
import { Request, Response } from 'express';
import axios from 'axios';
import { User } from '@shared/entities';
import { AppDataSource } from '../data-source';
import { cookieOptions } from '../modules/cookies';
import { issueTokens } from '../modules/tokens';
import { dbErrorCode } from '../modules/validation';

const OAUTH_TIMEOUT_MS = 5000;
const STATE_COOKIE = 'oauthState';
const STATE_TTL_MS = 10 * 60 * 1000;

interface SocialProfile {
  snsId: string;
  email?: string;
  nickname?: string;
}

interface Provider {
  name: 'google' | 'kakao' | 'naver';
  authorizeUrl: string;
  authorizeParams: () => Record<string, string | undefined>;
  tokenUrl: string;
  tokenParams: (code: string) => Record<string, string | undefined>;
  profileUrl: string;
  parseProfile: (data: any) => SocialProfile; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const providers: Record<Provider['name'], Provider> = {
  google: {
    name: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    authorizeParams: () => ({
      client_id: process.env.GOOGLE_CLIENT_ID,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'email',
    }),
    tokenUrl: 'https://oauth2.googleapis.com/token',
    tokenParams: (code) => ({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: process.env.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
    profileUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    parseProfile: (data) => ({ snsId: String(data?.id ?? ''), email: data?.email, nickname: data?.name }),
  },
  kakao: {
    name: 'kakao',
    authorizeUrl: 'https://kauth.kakao.com/oauth/authorize',
    authorizeParams: () => ({
      client_id: process.env.KAKAO_CLIENT_ID,
      redirect_uri: process.env.KAKAO_REDIRECT_URI,
      response_type: 'code',
      scope: 'profile_nickname account_email',
    }),
    tokenUrl: 'https://kauth.kakao.com/oauth/token',
    tokenParams: (code) => ({
      code,
      client_id: process.env.KAKAO_CLIENT_ID,
      client_secret: process.env.KAKAO_CLIENT_SECRET,
      redirect_uri: process.env.KAKAO_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
    profileUrl: 'https://kapi.kakao.com/v2/user/me',
    // 카카오의 id는 숫자이고, 이메일/프로필은 동의하지 않으면 없을 수 있다.
    parseProfile: (data) => ({
      snsId: String(data?.id ?? ''),
      email: data?.kakao_account?.email,
      nickname: data?.kakao_account?.profile?.nickname,
    }),
  },
  naver: {
    name: 'naver',
    authorizeUrl: 'https://nid.naver.com/oauth2.0/authorize',
    authorizeParams: () => ({
      response_type: 'code',
      client_id: process.env.NAVER_CLIENT_ID,
      redirect_uri: process.env.NAVER_REDIRECT_URI,
      scope: 'name email',
    }),
    tokenUrl: 'https://nid.naver.com/oauth2.0/token',
    tokenParams: (code) => ({
      code,
      client_id: process.env.NAVER_CLIENT_ID,
      client_secret: process.env.NAVER_CLIENT_SECRET,
      redirect_uri: process.env.NAVER_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
    profileUrl: 'https://openapi.naver.com/v1/nid/me',
    parseProfile: (data) => ({
      snsId: String(data?.response?.id ?? ''),
      email: data?.response?.email,
      nickname: data?.response?.name,
    }),
  },
};

const frontendUrl = () => process.env.FRONTEND_URL || 'https://fundmates.shop';

/** 실패는 JSON 500이 아니라 프런트엔드로 오류 코드와 함께 돌려보낸다. */
const redirectWithError = (res: Response, reason: string) => {
  res.clearCookie(STATE_COOKIE, cookieOptions());
  const url = new URL(frontendUrl());
  url.searchParams.set('login_error', reason);
  return res.redirect(url.toString());
};

const start = (provider: Provider) => (_req: Request, res: Response) => {
  // 로그인 CSRF 방지: 요청마다 새 state를 쿠키에 두고 콜백에서 대조한다.
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, cookieOptions(STATE_TTL_MS));

  const params = new URLSearchParams({ state });
  for (const [key, value] of Object.entries(provider.authorizeParams())) {
    if (value !== undefined) params.set(key, value);
  }
  res.redirect(`${provider.authorizeUrl}?${params.toString()}`);
};

const sameState = (expected: unknown, actual: unknown): boolean => {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected === '') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const callback = (provider: Provider) => async (req: Request, res: Response) => {
  const { code, state } = req.query;

  if (typeof code !== 'string' || code === '') {
    return redirectWithError(res, 'missing_code');
  }
  if (!sameState(req.cookies?.[STATE_COOKIE], state)) {
    return redirectWithError(res, 'invalid_state');
  }

  try {
    const tokenResponse = await axios.post(provider.tokenUrl, null, {
      params: provider.tokenParams(code),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: OAUTH_TIMEOUT_MS,
    });

    const profileResponse = await axios.get(provider.profileUrl, {
      headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
      timeout: OAUTH_TIMEOUT_MS,
    });

    const profile = provider.parseProfile(profileResponse.data);
    if (!profile.snsId) {
      return redirectWithError(res, 'profile_unavailable');
    }

    const userRepo = AppDataSource.getRepository(User);
    let user = await userRepo.findOne({ where: { provider: provider.name, snsId: profile.snsId } });

    if (!user) {
      if (!profile.email) {
        // 이메일 제공에 동의하지 않은 경우
        return redirectWithError(res, 'email_required');
      }
      if (await userRepo.exists({ where: { email: profile.email } })) {
        // 같은 이메일이 이미 다른 방식(이메일/비밀번호, 다른 소셜)으로 가입되어 있다.
        return redirectWithError(res, 'email_exists');
      }

      try {
        user = await userRepo.save(
          userRepo.create({
            provider: provider.name,
            snsId: profile.snsId,
            email: profile.email,
            nickname: (profile.nickname || `user_${profile.snsId}`).slice(0, 45),
          })
        );
      } catch (err) {
        if (dbErrorCode(err) === 'ER_DUP_ENTRY') return redirectWithError(res, 'email_exists');
        throw err;
      }
    }

    await issueTokens(user, res);
    res.clearCookie(STATE_COOKIE, cookieOptions());
    return res.redirect(frontendUrl());
  } catch (err) {
    // 응답 객체 전체에는 client_secret 등이 포함될 수 있으므로 메시지만 남긴다.
    console.error(`${provider.name} 로그인 실패:`, err instanceof Error ? err.message : err);
    return redirectWithError(res, 'oauth_failed');
  }
};

export const google = start(providers.google);
export const googleCallBack = callback(providers.google);
export const kakao = start(providers.kakao);
export const kakaoCallBack = callback(providers.kakao);
export const naver = start(providers.naver);
export const naverCallBack = callback(providers.naver);
