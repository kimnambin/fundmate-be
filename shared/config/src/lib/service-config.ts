export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'ALL';

export interface JwtRule {
  method: HTTPMethod;
  path: string;
  required: boolean;
}

export interface ServiceConfig {
  name: string;
  swagger: string;
  host: string;
  port: number;
  url: string;
  base: string[];
  jwtRules: JwtRule[];
}

const isDocker = process.env.NODE_ENV === 'docker';
/**
 * jwtRules: 요청 경로(전체 경로, 접두사 일치)에 대한 로그인 요구 여부.
 * 규칙에 맞는 경로가 없으면 **로그인 필수**이므로, 공개 경로만 `required: false`로 열거한다.
 * 더 구체적인 규칙(고정 세그먼트가 많은 것)이 우선한다. 실제 라우트와의 일치는 api-gateway의 테스트가 검사한다.
 */
const rowServiceConfig: Record<string, Omit<ServiceConfig, 'url' | 'host'>> = {
  'ai-service': {
    name: 'ai-service',
    swagger: 'ai.json',
    port: Number(process.env.AI_SERVICE_PORT) || 3001,
    base: ['/ai'],
    // 유료 LLM을 호출하므로 로그인 필수 (비로그인 허용이 필요하면 required: false로 바꾸고 서비스의 requireUser도 함께 조정)
    jwtRules: [
      { method: 'POST', path: '/ai/summarize', required: true },
      { method: 'POST', path: '/ai/requests', required: true },
    ],
  },
  'auth-service': {
    name: 'auth-service',
    swagger: 'auths.json',
    port: Number(process.env.AUTH_SERVICE_PORT) || 3002,
    base: ['/auth', '/oauth'],
    jwtRules: [
      { method: 'POST', path: '/auth/codes/send', required: false },
      { method: 'POST', path: '/auth/codes/verify', required: false },
      { method: 'POST', path: '/auth/signup', required: false },
      { method: 'POST', path: '/auth/login', required: false },
      // 액세스 토큰이 만료된 뒤에 호출하므로 로그인 없이 열고, 리프레시 토큰 검증은 auth-service가 한다.
      { method: 'POST', path: '/auth/token', required: false },
      { method: 'POST', path: '/auth/logout', required: true },
      { method: 'PATCH', path: '/auth/password', required: false },
      { method: 'ALL', path: '/oauth', required: false },
    ],
  },
  'funding-service': {
    name: 'funding-service',
    swagger: 'funding.json',
    port: Number(process.env.FUNDING_SERVICE_PORT) || 3003,
    base: ['/projects', '/options', '/api/projects', '/profiles'],
    jwtRules: [
      { method: 'GET', path: '/projects/:id', required: false },
      { method: 'POST', path: '/projects', required: true },
      { method: 'DELETE', path: '/options/:id', required: true },
      { method: 'ALL', path: '/api/projects', required: false },
      { method: 'GET', path: '/profiles/recent-completed', required: true },
      { method: 'GET', path: '/profiles/my-projects', required: true },
      { method: 'GET', path: '/profiles/my-comments', required: true },
      { method: 'GET', path: '/profiles/:id', required: false },
    ],
  },
  'interaction-service': {
    name: 'interaction-service',
    swagger: 'interactions.json',
    port: Number(process.env.INTERACTION_SERVICE_PORT) || 3004,
    base: ['/interactionmain', '/users/likes', '/comment'],
    jwtRules: [
      { method: 'POST', path: '/users/likes/:id', required: true },
      { method: 'DELETE', path: '/users/likes/:id', required: true },
      { method: 'GET', path: '/users/likes', required: true },
      { method: 'POST', path: '/comment/:id', required: true },
      { method: 'DELETE', path: '/comment/:id', required: true },
      { method: 'GET', path: '/comment/:id', required: true },
      { method: 'GET', path: '/interactionmain', required: true },
    ],
  },
  'payment-service': {
    name: 'payment-service',
    swagger: 'payment.json',
    port: Number(process.env.PAYMENT_SERVICE_PORT) || 3005,
    base: ['/payments', '/reservations', '/statistics'],
    jwtRules: [
      { method: 'ALL', path: '/payments', required: true },
      { method: 'ALL', path: '/reservations', required: true },
      { method: 'ALL', path: '/statistics', required: true },
    ],
  },
  'public-service': {
    name: 'public-service',
    swagger: 'public.json',
    port: Number(process.env.PUBLIC_SERVICE_PORT) || 3006,
    base: ['/datas'],
    jwtRules: [
      { method: 'ALL', path: '/datas/keyword', required: false },
      { method: 'ALL', path: '/datas/option', required: false },
    ],
  },
  'user-service': {
    name: 'user-service',
    swagger: 'users.json',
    port: Number(process.env.USER_SERVICE_PORT) || 3007,
    base: ['/users'],
    jwtRules: [
      { method: 'ALL', path: '/users/account', required: true },
      { method: 'ALL', path: '/users/mypage', required: true },
      { method: 'ALL', path: '/users/projects', required: true },
      { method: 'ALL', path: '/users/following', required: true },
      { method: 'ALL', path: '/users/maker', required: false },
      { method: 'ALL', path: '/users/supporter', required: false },
    ],
  },
};

export const serviceConfig: Record<string, ServiceConfig> = Object.values(rowServiceConfig).reduce((acc, service) => {
  const host = isDocker ? service.name : 'localhost';
  acc[service.name] = {
    ...service,
    swagger: `/assets/${service.swagger}`,
    host,
    url: `http://${host}:${service.port}`,
  };
  return acc;
}, {} as Record<string, ServiceConfig>);
