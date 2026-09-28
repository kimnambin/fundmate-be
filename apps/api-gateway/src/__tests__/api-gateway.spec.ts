import http, { IncomingMessage, Server } from 'http';
import type { AddressInfo } from 'net';
import type { Express } from 'express';
import express from 'express';
import jwt from 'jsonwebtoken';

/**
 * 실제 게이트웨이 앱(createApp)을 띄우고, 서비스 자리에는 요청을 기록하는 가짜 서버를 둔다.
 * 서비스 포트는 config를 불러오기 전에 환경변수로 정한다.
 */

const SERVICES = [
  ['ai-service', 'AI_SERVICE_PORT'],
  ['auth-service', 'AUTH_SERVICE_PORT'],
  ['funding-service', 'FUNDING_SERVICE_PORT'],
  ['interaction-service', 'INTERACTION_SERVICE_PORT'],
  ['payment-service', 'PAYMENT_SERVICE_PORT'],
  ['public-service', 'PUBLIC_SERVICE_PORT'],
  ['user-service', 'USER_SERVICE_PORT'],
] as const;

interface Received {
  service: string;
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

const received: Received[] = [];
const upstreams: Server[] = [];
let app: Express;
let server: Server;
let base: string;

const SECRET = 'access-secret';
const validAccess = (userId = 1, email = 'a@example.com') =>
  jwt.sign({ userId, email }, SECRET, { expiresIn: '30m', issuer: 'Fundi' });
const expiredAccess = () => jwt.sign({ userId: 1, email: 'a@example.com' }, SECRET, { expiresIn: -10, issuer: 'Fundi' });
const refreshToken = 'REFRESH.TOKEN.VALUE';

const listen = (srv: Server, port = 0) =>
  new Promise<number>((resolve) => srv.listen(port, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port)));

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.PRIVATE_KEY = SECRET;
  process.env.NODE_ENV = 'test';
  process.env.HOST = '127.0.0.1';
  process.env.CORS_ORIGINS = 'https://front.example.com';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);

  for (const [name, envName] of SERVICES) {
    const upstream = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ service: name, method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        const path = (req.url ?? '').split('?')[0];
        if (path.endsWith('/__500')) {
          res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'upstream boom' }));
        } else if (path.endsWith('/__404')) {
          res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'nope' }));
        } else if (path.startsWith('/oauth/')) {
          res
            .writeHead(302, { location: 'https://accounts.example.com/auth', 'set-cookie': ['oauthState=abc; HttpOnly'] })
            .end();
        } else if (path.endsWith('/__204')) {
          res.writeHead(204).end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, service: name }));
        }
      });
    });
    upstreams.push(upstream);
    process.env[envName] = String(await listen(upstream));
  }

  const { createApp } = await import('../main');
  app = createApp();
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  for (const s of [server, ...upstreams]) await new Promise((resolve) => s.close(resolve));
});

beforeEach(() => {
  received.length = 0;
});

const call = async (
  method: string,
  path: string,
  opts: { cookie?: string; headers?: Record<string, string>; body?: unknown; baseUrl?: string } = {}
) => {
  const res = await fetch((opts.baseUrl ?? base) + path, {
    method,
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(opts.cookie ? { cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, headers: res.headers, setCookie: res.headers.getSetCookie() };
};

const authCookie = (userId = 1) => `accessToken=${validAccess(userId)}; refreshToken=${refreshToken}`;
const lastReceived = () => received[received.length - 1];

// --- H1 ----------------------------------------------------------------------
describe('H1: 사용자 정보가 요청 사이에 섞이지 않는다', () => {
  it('로그인한 요청 다음의 비로그인 요청에는 이전 사용자의 헤더가 붙지 않는다', async () => {
    await call('GET', '/api/projects', { cookie: authCookie(42) });
    expect(lastReceived().headers['x-user-id']).toBe('42');

    await call('GET', '/api/projects');
    expect(lastReceived().headers['x-user-id']).toBeUndefined();
    expect(lastReceived().headers['x-user-email']).toBeUndefined();
    expect(lastReceived().headers['x-refresh-token']).toBeUndefined();
  });

  it('동시에 들어온 서로 다른 사용자의 요청이 각자의 신원으로 전달된다', async () => {
    await Promise.all([1, 2, 3, 4, 5, 6].map((id) => call('GET', '/api/projects', { cookie: authCookie(id) })));
    const ids = received.map((r) => r.headers['x-user-id']).sort();
    expect(ids).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('클라이언트가 직접 보낸 x-user-* 헤더는 서비스로 전달되지 않는다', async () => {
    await call('GET', '/api/projects', { headers: { 'x-user-id': '999', 'x-user-email': 'evil@x.com', 'x-refresh-token': 'x' } });
    expect(lastReceived().headers['x-user-id']).toBeUndefined();
    expect(lastReceived().headers['x-user-email']).toBeUndefined();
    expect(lastReceived().headers['x-refresh-token']).toBeUndefined();
  });

  it('토큰은 필요한 서비스(auth, user)에만 전달되고 액세스 토큰 원문은 어디에도 가지 않는다', async () => {
    await call('DELETE', '/users/account', { cookie: authCookie(), body: { password: 'pw' } });
    expect(lastReceived().service).toBe('user-service');
    expect(lastReceived().headers['x-refresh-token']).toBe(refreshToken);
    expect(lastReceived().body).toBe(JSON.stringify({ password: 'pw' })); // DELETE 본문도 전달

    await call('GET', '/api/projects', { cookie: authCookie() });
    expect(lastReceived().service).toBe('funding-service');
    expect(lastReceived().headers['x-refresh-token']).toBeUndefined();
    for (const r of received) expect(r.headers['x-access-token']).toBeUndefined();
  });

  it('클라이언트 IP를 x-forwarded-for로 전달한다', async () => {
    await call('GET', '/api/projects');
    expect(lastReceived().headers['x-forwarded-for']).toBeTruthy();
  });
});

// --- H2 ----------------------------------------------------------------------
describe('H2: 인증 경계', () => {
  const protectedRoutes: [string, string, string][] = [
    ['GET', '/users/mypage', 'user-service'],
    ['GET', '/users/mypage/profile', 'user-service'],
    ['PUT', '/users/mypage/profile', 'user-service'],
    ['DELETE', '/users/account', 'user-service'],
    ['GET', '/users/projects', 'user-service'],
    ['GET', '/users/projects/statistics', 'user-service'],
    ['POST', '/users/following', 'user-service'],
    ['DELETE', '/users/following', 'user-service'],
    ['GET', '/profiles/my-projects', 'funding-service'],
    ['GET', '/profiles/recent-completed', 'funding-service'],
    ['GET', '/profiles/my-comments', 'funding-service'],
    ['POST', '/projects', 'funding-service'],
    ['DELETE', '/options/1', 'funding-service'],
    ['GET', '/users/likes', 'interaction-service'],
    ['POST', '/users/likes/1', 'interaction-service'],
    ['POST', '/comment/1', 'interaction-service'],
    ['GET', '/interactionmain', 'interaction-service'],
    ['GET', '/reservations', 'payment-service'],
    ['PUT', '/reservations/1/payment_info', 'payment-service'],
    ['GET', '/statistics/summary', 'payment-service'],
    ['POST', '/payments', 'payment-service'],
    ['POST', '/auth/logout', 'auth-service'],
  ];

  it.each(protectedRoutes)('%s %s → 로그인 없이는 401이고 서비스까지 가지 않는다', async (method, path) => {
    const res = await call(method, path, { body: method === 'GET' ? undefined : {} });
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it.each(protectedRoutes)('%s %s → 로그인하면 %s 로 전달된다', async (method, path, service) => {
    const res = await call(method, path, { cookie: authCookie(), body: method === 'GET' ? undefined : {} });
    expect(res.status).toBe(200);
    expect(lastReceived().service).toBe(service);
  });

  const publicRoutes: [string, string, string][] = [
    ['GET', '/api/projects', 'funding-service'],
    ['GET', '/api/projects/recent?project_id=1', 'funding-service'],
    ['GET', '/api/projects/popular', 'funding-service'],
    ['GET', '/projects/5', 'funding-service'],
    ['GET', '/profiles/7', 'funding-service'],
    ['GET', '/users/maker/3', 'user-service'],
    ['GET', '/users/supporter/3', 'user-service'],
    ['POST', '/auth/login', 'auth-service'],
    ['POST', '/auth/signup', 'auth-service'],
    ['POST', '/auth/codes/send', 'auth-service'],
    ['POST', '/auth/codes/verify', 'auth-service'],
    ['PATCH', '/auth/password', 'auth-service'],
    ['GET', '/oauth/google', 'auth-service'],
    ['POST', '/datas/option', 'public-service'],
    ['POST', '/datas/keyword', 'public-service'],
    ['POST', '/ai/summarize', 'ai-service'],
    ['POST', '/ai/requests', 'ai-service'],
  ];

  it.each(publicRoutes)('%s %s → 공개 경로는 로그인 없이 %s 로 전달된다', async (method, path, service) => {
    const res = await call(method, path, { body: method === 'GET' ? undefined : {} });
    expect([200, 302]).toContain(res.status);
    expect(lastReceived().service).toBe(service);
  });

  it('규칙에 없는 경로는 안전한 쪽(인증 필수)으로 처리한다', async () => {
    for (const path of ['/users/unknown', '/users//mypage', '/USERS/mypage']) {
      const res = await call('GET', path);
      expect([401, 404]).toContain(res.status);
    }
    expect(received).toHaveLength(0);
  });

  it('없는 서비스 경로는 404', async () => {
    expect((await call('GET', '/nothing')).status).toBe(404);
  });

  it('/profiles/:id 공개 규칙이 /profiles/my-projects 를 열어 주지 않는다', async () => {
    expect((await call('GET', '/profiles/my-projects')).status).toBe(401);
    expect((await call('GET', '/profiles/7')).status).toBe(200);
  });
});

// --- H3 ----------------------------------------------------------------------
describe('H3: 토큰 갱신', () => {
  it('액세스 토큰이 없거나 만료되어도 리프레시 토큰으로 /auth/token 이 서비스에 도달한다', async () => {
    for (const cookie of [`refreshToken=${refreshToken}`, `accessToken=${expiredAccess()}; refreshToken=${refreshToken}`]) {
      received.length = 0;
      const res = await call('POST', '/auth/token', { cookie });
      expect(res.status).toBe(200);
      expect(lastReceived().service).toBe('auth-service');
      expect(lastReceived().headers['x-refresh-token']).toBe(refreshToken);
      expect(lastReceived().headers['x-user-id']).toBeUndefined();
    }
  });

  it('보호된 경로에서 액세스 토큰이 만료되면 401 "토큰 만료"로 갱신을 안내한다', async () => {
    const expired = await call('GET', '/users/mypage', { cookie: `accessToken=${expiredAccess()}; refreshToken=${refreshToken}` });
    expect(expired.status).toBe(401);
    expect(expired.body.message).toBe('토큰 만료');

    const onlyRefresh = await call('GET', '/users/mypage', { cookie: `refreshToken=${refreshToken}` });
    expect(onlyRefresh.status).toBe(401);
    expect(onlyRefresh.body.message).toBe('토큰 만료');

    const none = await call('GET', '/users/mypage');
    expect(none.status).toBe(401);
    expect(none.body.message).toBe('로그인이 필요합니다.');
  });

  it('위조/다른 발급자의 토큰은 인증되지 않는다', async () => {
    const forged = jwt.sign({ userId: 1 }, 'wrong', { issuer: 'Fundi' });
    const otherIssuer = jwt.sign({ userId: 1 }, SECRET, { issuer: 'Someone' });
    const none = jwt.sign({ userId: 1 }, '', { algorithm: 'none' as never });
    for (const token of [forged, otherIssuer, none]) {
      expect((await call('GET', '/users/mypage', { cookie: `accessToken=${token}` })).status).toBe(401);
    }
    // 공개 경로에서는 익명으로 처리된다
    await call('GET', '/api/projects', { cookie: `accessToken=${forged}` });
    expect(lastReceived().headers['x-user-id']).toBeUndefined();
  });
});

// --- H4 로그 -------------------------------------------------------------------
describe('H4: 로그', () => {
  it('요청 본문은 기록하지 않고 URL/쿼리의 민감한 값은 마스킹한다', async () => {
    const { redactUrl, redactQuery } = await import('@shared/logger');
    expect(redactUrl('/oauth/google/callback?code=abc&state=xyz&lang=ko')).toBe(
      '/oauth/google/callback?code=***&state=***&lang=ko'
    );
    expect(redactUrl('/health')).toBe('/health');
    expect(redactQuery({ password: 'p', page: '1', refresh_token: 't' })).toEqual({ password: '***', page: '1', refresh_token: '***' });

    const src = require('fs').readFileSync(require('path').join(__dirname, '../../../../shared/logger/src/lib/logger.ts'), 'utf8');
    expect(src).not.toMatch(/JSON\.stringify\(req\.body\)/);
  });
});

// --- H5 / M6 업로드 --------------------------------------------------------------
describe('H5: 업로드', () => {
  it('로그인 없이는 presign / complete 모두 401', async () => {
    expect((await call('GET', '/upload/presign?contentType=image/png')).status).toBe(401);
    expect((await call('POST', '/upload/complete', { body: { key: 'uploads/1/1-x.png' } })).status).toBe(401);
  });

  describe('라우터 동작 (가짜 저장소)', () => {
    let uploadBase: string;
    let uploadServer: Server;
    const presigned: { key: string; contentType: string; contentLength?: number }[] = [];
    const existing = new Set<string>();

    beforeAll(async () => {
      const { createAwsRouter } = await import('../routes/aws-route');
      const router = createAwsRouter(
        {
          presignPut: async (key, contentType, { contentLength }) => {
            presigned.push({ key, contentType, contentLength });
            return `https://s3.example.com/${key}?signed`;
          },
          exists: async (key) => existing.has(key),
          publicUrl: (key) => `https://bucket.s3.ap-northeast-2.amazonaws.com/${key}`,
        },
        1024
      );
      const upload = express();
      upload.use(express.json());
      upload.use((req, res, next) => {
        res.locals.user = { userId: Number(req.header('x-test-user') ?? 7), email: 'u@x.com' };
        next();
      });
      upload.use('/upload', router);
      uploadServer = http.createServer(upload);
      uploadBase = `http://127.0.0.1:${await listen(uploadServer)}`;
    });
    afterAll(() => new Promise((resolve) => uploadServer.close(resolve)));

    it('허용된 이미지 타입만 presign 하고 키에 파일 이름을 넣지 않는다', async () => {
      const ok = await call('GET', '/upload/presign?contentType=image/png&filename=../../evil.php', { baseUrl: uploadBase });
      expect(ok.status).toBe(200);
      expect(ok.body.key).toMatch(/^uploads\/7\/\d+-[0-9a-f-]{36}\.png$/);
      expect(ok.body.key).not.toContain('evil');

      for (const contentType of ['text/html', 'image/svg+xml', 'application/javascript', '', undefined]) {
        const path = `/upload/presign${contentType === undefined ? '' : `?contentType=${encodeURIComponent(contentType)}`}`;
        expect((await call('GET', path, { baseUrl: uploadBase })).status).toBe(400);
      }
    });

    it('size를 보내면 범위를 검사하고 서명에 포함한다', async () => {
      presigned.length = 0;
      expect((await call('GET', '/upload/presign?contentType=image/jpeg&size=500', { baseUrl: uploadBase })).status).toBe(200);
      expect(presigned[0].contentLength).toBe(500);
      for (const size of ['0', '-1', '1025', 'abc', '1.5']) {
        expect((await call('GET', `/upload/presign?contentType=image/jpeg&size=${size}`, { baseUrl: uploadBase })).status).toBe(400);
      }
    });

    it('complete: 내가 발급받았고 실제로 올라간 키만 URL을 만들어 준다', async () => {
      const key = 'uploads/7/1700000000000-123e4567-e89b-12d3-a456-426614174000.png';
      const post = (k: unknown, user = '7') =>
        call('POST', '/upload/complete', { baseUrl: uploadBase, body: { key: k }, headers: { 'x-test-user': user } });

      expect((await post(key)).status).toBe(400); // 아직 업로드되지 않음
      existing.add(key);
      const ok = await post(key);
      expect(ok.status).toBe(200);
      expect(ok.body.url).toBe(`https://bucket.s3.ap-northeast-2.amazonaws.com/${key}`);

      expect((await post(key, '8')).status).toBe(400); // 남의 키
      for (const bad of ['config/secret.txt', 'uploads/7/../../x.png', 'uploads/7/1-x.png', undefined, 5, {}]) {
        expect((await post(bad)).status).toBe(400);
      }
    });
  });
});

// --- M1 에러 처리 ----------------------------------------------------------------
describe('M1: 에러 처리', () => {
  it('서비스가 돌려준 4xx/5xx 상태와 JSON 본문을 그대로 전달한다', async () => {
    const e500 = await call('GET', '/datas/option/__500');
    expect(e500.status).toBe(500);
    expect(e500.body).toEqual({ message: 'upstream boom' });
    const e404 = await call('GET', '/datas/option/__404');
    expect([e404.status, e404.body]).toEqual([404, { message: 'nope' }]);
  });

  it('204는 본문 없이 전달한다', async () => {
    const res = await call('GET', '/datas/option/__204');
    expect([res.status, res.text]).toEqual([204, '']);
  });

  it('서비스가 내려가 있으면 502이고 스택을 노출하지 않는다', async () => {
    const dead = http.createServer();
    const deadPort = await listen(dead);
    await new Promise((resolve) => dead.close(resolve));
    const { serviceConfig, ServiceClient } = await import('@shared/config');
    const client = new ServiceClient({ ...serviceConfig['public-service'], url: `http://127.0.0.1:${deadPort}` });
    const { serviceClients } = await import('@shared/config');
    const original = serviceClients['public-service'];
    serviceClients['public-service'] = client;
    try {
      const res = await call('POST', '/datas/option', { body: {} });
      expect(res.status).toBe(502);
      expect(res.text).not.toMatch(/at .*\.(ts|js):\d+/);
    } finally {
      serviceClients['public-service'] = original;
    }
  });

  it('처리되지 않은 오류도 스택 없이 JSON 500', async () => {
    const res = await call('POST', '/auth/login', { headers: { 'content-type': 'application/json' }, body: undefined });
    expect(res.text).not.toMatch(/at .*\.(ts|js):\d+/);
    const bad = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toMatch(/SyntaxError|at /);
  });
});

// --- M2 OAuth 리다이렉트 ------------------------------------------------------------
describe('M2: OAuth 리다이렉트', () => {
  it('서비스의 302, Location, Set-Cookie를 그대로 전달한다', async () => {
    const res = await call('GET', '/oauth/google');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://accounts.example.com/auth');
    expect(res.setCookie).toEqual(['oauthState=abc; HttpOnly']);
  });
});

// --- M3 CORS ---------------------------------------------------------------------
describe('M3: CORS', () => {
  it('허용된 origin에는 헤더를, 허용되지 않은 origin에는 에러 없이 헤더 없이 응답한다', async () => {
    const ok = await call('GET', '/api/projects', { headers: { origin: 'https://front.example.com' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://front.example.com');
    expect(ok.headers.get('access-control-allow-credentials')).toBe('true');

    const evil = await call('GET', '/api/projects', { headers: { origin: 'https://evil.example.com' } });
    expect(evil.status).toBe(200);
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('로컬 개발 origin은 CORS_ORIGINS를 지정하면 운영에서 열리지 않는다', async () => {
    const res = await call('GET', '/api/projects', { headers: { origin: 'http://localhost:5000' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// --- M4 헬스체크 -------------------------------------------------------------------
describe('M4: 헬스체크', () => {
  it('/health 는 게이트웨이 자체 상태 200', async () => {
    const res = await call('GET', '/health');
    expect([res.status, res.body.status]).toEqual([200, 'ok']);
  });

  it('/health-checks 는 모두 정상이면 200, 하나라도 내려가면 503이며 스택이 없다', async () => {
    // 가짜 서비스는 /health 에도 200을 준다
    const ok = await call('GET', '/health-checks');
    expect(ok.status).toBe(200);

    const { clearHealthCache } = await import('../services/health-service');
    clearHealthCache();
    const victim = upstreams[0];
    const port = (victim.address() as AddressInfo).port;
    await new Promise((resolve) => victim.close(resolve));
    try {
      const degraded = await call('GET', '/health-checks');
      expect(degraded.status).toBe(503);
      expect(degraded.body.overall).toBe('degraded');
      expect(degraded.text).not.toMatch(/at .*\.(ts|js):\d+|\\n\s+at /);
    } finally {
      clearHealthCache();
      await new Promise<void>((resolve) => victim.listen(port, '127.0.0.1', resolve));
    }
  });
});

// --- M5 rate limit / 보안 헤더 --------------------------------------------------------
describe('M5: rate limit, 보안 헤더', () => {
  it('보안 헤더가 붙는다', async () => {
    const res = await call('GET', '/api/projects');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('/auth/* 는 분당 30회를 넘으면 429', async () => {
    const { createApp } = await import('../main');
    const fresh = http.createServer(createApp());
    const freshBase = `http://127.0.0.1:${await listen(fresh)}`;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 32; i++) statuses.push((await call('POST', '/auth/login', { baseUrl: freshBase, body: {} })).status);
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(30)).toEqual([429, 429]);
      // 다른 경로는 영향이 없다
      expect((await call('GET', '/api/projects', { baseUrl: freshBase })).status).toBe(200);
      // 헬스체크는 제한 대상이 아니다
      expect((await call('GET', '/health', { baseUrl: freshBase })).status).toBe(200);
    } finally {
      await new Promise((resolve) => fresh.close(resolve));
    }
  });
});

// --- 규칙 판정 단위 테스트 -------------------------------------------------------------
describe('isAuthRequired', () => {
  it('규칙이 없으면 인증 필수, 더 구체적인 규칙이 우선', async () => {
    const { isAuthRequired } = await import('../middlewares/jwt-rules');
    const rules = [
      { method: 'GET' as const, path: '/profiles/:id', required: false },
      { method: 'GET' as const, path: '/profiles/my-projects', required: true },
    ];
    expect(isAuthRequired(rules, 'GET', '/profiles/1')).toBe(false);
    expect(isAuthRequired(rules, 'GET', '/profiles/my-projects')).toBe(true);
    expect(isAuthRequired(rules, 'POST', '/profiles/1')).toBe(true);
    expect(isAuthRequired([], 'GET', '/anything')).toBe(true);
  });
});
