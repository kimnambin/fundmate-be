import { CACHE_MAX_ENTRIES, CACHE_TTL_MS } from './SgisConfig';

interface Entry {
  expiresAt: number;
  value: Promise<unknown>;
}

const store = new Map<string, Entry>();

/**
 * 성공한 응답만 TTL 동안 캐시한다. 진행 중인 요청(Promise)도 공유하므로
 * 같은 키의 동시 요청은 SGIS를 한 번만 호출한다.
 */
export const cached = <T>(key: string, loader: () => Promise<T>): Promise<T> => {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value as Promise<T>;
  }

  const value = loader();
  store.delete(key);
  store.set(key, { expiresAt: now + CACHE_TTL_MS, value });

  // 실패는 캐시하지 않는다.
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });

  while (store.size > CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  return value;
};

export const clearCache = () => store.clear();
