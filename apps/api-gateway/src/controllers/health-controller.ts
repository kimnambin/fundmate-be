import { Request, Response } from 'express';
import StatusCode from 'http-status-codes';
import { checkAllServices, HealthResult } from '../services/health-service';

/** 게이트웨이 자체 상태. 컨테이너 healthcheck와 로드 밸런서용 (하위 서비스를 호출하지 않음) */
export const selfHealth = (_req: Request, res: Response) =>
  res.status(StatusCode.OK).json({ status: 'ok', service: 'api-gateway', timestamp: new Date().toISOString() });

/** 전체 서비스 상태 집계 (배포 전환 스크립트용). 저하 상태는 503 */
export const healthCheck = async (_req: Request, res: Response) => {
  const results: HealthResult[] = await checkAllServices();
  const overall = results.every((r) => r.status === 'ok') ? 'ok' : 'degraded';
  res.status(overall === 'ok' ? StatusCode.OK : StatusCode.SERVICE_UNAVAILABLE).json({ overall, services: results });
};
