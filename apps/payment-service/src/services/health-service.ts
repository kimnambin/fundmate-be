export interface HealthInfo {
  status: 'ok' | 'error';
  service: string;
  timestamp: string;
}

export function getHealthInfo(): HealthInfo {
  return {
    status: 'ok',
    service: 'payment-service',
    timestamp: new Date().toISOString(),
  };
}
