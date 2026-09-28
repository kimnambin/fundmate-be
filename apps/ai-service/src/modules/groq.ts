import axios, { isAxiosError } from 'axios';
import { HttpError } from '@shared/config';

/** Groq 호출 1건의 제한 시간. 응답이 늦어도 요청이 무한정 쌓이지 않게 한다. */
export const GROQ_TIMEOUT_MS = 20_000;

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/**
 * Groq는 OpenAI 호환 API다. 키 이름은 GROQ_API_KEY를 쓰고,
 * 배포 설정(cd.yml)이 아직 OPENAI_API_KEY로 넘기는 경우를 위해 그 이름도 받아 준다.
 */
const config = () => ({
  apiKey: process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY,
  baseUrl: process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
  model: process.env.GROQ_MODEL || 'llama3-70b-8192',
});

/** 외부 API 오류를 클라이언트가 재시도 여부를 판단할 수 있는 상태 코드로 바꾼다. */
export const toHttpError = (err: unknown): HttpError => {
  if (err instanceof HttpError) return err;

  if (isAxiosError(err)) {
    const status = err.response?.status;
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      return new HttpError(504, 'AI 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.');
    }
    if (status === 429) {
      return new HttpError(429, 'AI 요청이 많아 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
    // 키 오류(401/403)나 모델 종료(404)는 사용자가 고칠 수 있는 문제가 아니라 서버 설정 문제다.
    return new HttpError(502, 'AI 서비스 호출에 실패했습니다.');
  }
  return new HttpError(500, 'AI 호출 중 오류가 발생했습니다.');
};

/** 로그에는 상태 코드와 Groq의 오류 메시지만 남긴다. (요청 헤더의 API 키나 사용자 입력 포함 안 함) */
const describe = (err: unknown): string => {
  if (isAxiosError(err)) {
    const detail = (err.response?.data as { error?: { message?: string } } | undefined)?.error?.message;
    return `status=${err.response?.status ?? '-'} code=${err.code ?? '-'} ${detail ?? err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
};

export const callGroq = async (
  messages: ChatMessage[],
  options: { temperature: number; maxTokens: number }
): Promise<string> => {
  const { apiKey, baseUrl, model } = config();
  if (!apiKey) {
    console.error('Groq API 키가 설정되지 않았습니다. (GROQ_API_KEY)');
    throw new HttpError(503, 'AI 서비스를 사용할 수 없습니다.');
  }

  try {
    const response = await axios.post(
      `${baseUrl}/chat/completions`,
      { model, messages, temperature: options.temperature, max_tokens: options.maxTokens },
      {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: GROQ_TIMEOUT_MS,
      }
    );
    return (response.data?.choices?.[0]?.message?.content as string | undefined) ?? '';
  } catch (err) {
    console.error('Groq API 오류:', describe(err));
    throw toHttpError(err);
  }
};
