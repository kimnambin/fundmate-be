import axios from 'axios';
import { ServiceConfig, serviceConfig } from '@shared/config';

export interface HealthResult {
  name: string;
  status: 'ok' | 'error' | 'down';
  latency?: number;
  error?: string;
}

const CACHE_MS = 5000;
let cache: { at: number; results: Promise<HealthResult[]> } | null = null;

async function check(name: string, url: string): Promise<HealthResult> {
  try {
    const start = Date.now();
    const resp = await axios.get(url, { timeout: 5000 });
    return { name, status: resp.status === 200 ? 'ok' : 'error', latency: Date.now() - start };
  } catch (err) {
    // 스택에는 내부 호스트명/파일 경로가 들어 있으므로 메시지만 내보낸다.
    return { name, status: 'down', error: err instanceof Error ? err.message : String(err) };
  }
}

/** 공개 엔드포인트가 호출될 때마다 모든 서비스를 두드리지 않도록 결과를 몇 초 캐시한다. */
export function checkAllServices(): Promise<HealthResult[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.results;

  const results = Promise.all(
    Object.values(serviceConfig).map((svc: ServiceConfig) => check(svc.name, `${svc.url}/health`))
  );
  cache = { at: now, results };
  return results;
}

export const clearHealthCache = () => {
  cache = null;
};
