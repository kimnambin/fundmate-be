import { Request, RequestHandler } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 고정 윈도우 카운터 (프로세스 메모리). 인스턴스가 여러 개면 인스턴스별로 따로 센다.
 * 여러 인스턴스에서 하나의 한도가 필요하면 앞단(nginx/WAF)이나 Redis 기반으로 바꿔야 한다.
 */
export class WindowCounter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly windowMs: number, private readonly maxKeys = 50000) {
    setInterval(() => this.sweep(), Math.max(windowMs, 60000)).unref();
  }

  private sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  /** 카운트를 1 올리고 현재 값을 돌려준다. */
  hit(key: string): number {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      if (this.buckets.size >= this.maxKeys) this.sweep();
      if (this.buckets.size >= this.maxKeys) {
        // 메모리 보호: 가장 오래된 키를 버린다.
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count;
  }

  count(key: string): number {
    const bucket = this.buckets.get(key);
    return bucket && bucket.resetAt > Date.now() ? bucket.count : 0;
  }

  reset(key: string) {
    this.buckets.delete(key);
  }

  /** 다음 윈도우까지 남은 초 (없으면 0) */
  retryAfterSeconds(key: string): number {
    const bucket = this.buckets.get(key);
    return bucket ? Math.max(0, Math.ceil((bucket.resetAt - Date.now()) / 1000)) : 0;
  }
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** 기본값: 클라이언트 IP */
  key?: (req: Request) => string;
  message?: string;
}

/** 요청 수 제한 미들웨어. `app.set('trust proxy', ...)`를 설정해야 프록시 뒤에서 실제 IP를 쓴다. */
export const rateLimit = ({ windowMs, max, key, message }: RateLimitOptions): RequestHandler => {
  const counter = new WindowCounter(windowMs);
  return (req, res, next) => {
    const id = key ? key(req) : req.ip || 'unknown';
    if (counter.hit(id) > max) {
      res.setHeader('Retry-After', String(counter.retryAfterSeconds(id)));
      res.status(429).json({ message: message ?? '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' });
      return;
    }
    next();
  };
};
