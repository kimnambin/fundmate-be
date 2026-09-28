import http, { Server } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

/**
 * 실제 라우터/컨트롤러/전역 에러 핸들러를 express로 띄운다.
 * DB는 메모리 위의 가짜 저장소, 다른 서비스(funding/payment/interaction)는 요청을 기록하는 가짜 HTTP 서버로 대신한다.
 * 비밀번호 검증은 공통 모듈(pbkdf2)을 그대로 쓴다.
 */

jest.mock('@shared/entities', () => ({
  User: class User {},
  Follow: class Follow {},
  Image: class Image {},
  Age: class Age {},
  Category: class Category {},
  InterestCategory: class InterestCategory {},
  Token: class Token {},
  userEntities: [],
}));

// --- 가짜 다른 서비스 ------------------------------------------------------------
interface Received {
  service: string;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}
const received: Received[] = [];
const upstreams: Server[] = [];
type Responder = (req: Received) => { status: number; body: unknown } | undefined;
const responders: Record<string, Responder | undefined> = {};

const listen = (srv: Server) =>
  new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port)));

// --- 메모리 DB -----------------------------------------------------------------
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const tables: Record<string, Row[]> = {};
const executedSql: { sql: string; params?: unknown[] }[] = [];
const sqlCounts = { ongoingProjects: 0, pendingPayments: 0 };
let nextId = 100;
const failInsertWith: { code?: string } = {};

const resetDb = () => {
  for (const name of ['User', 'Follow', 'Image', 'Age', 'Category', 'InterestCategory', 'Token']) tables[name] = [];
  tables.Age.push({ ageId: 1, generation: '10대' }, { ageId: 2, generation: '20대' });
  tables.Category.push({ categoryId: 1, name: '테크' }, { categoryId: 2, name: '푸드' });
  tables.User.push(
    { userId: 1, nickname: 'alice', email: 'alice@example.com', contents: '안녕', gender: 'F', age: tables.Age[0], image: null, password: '', salt: '' },
    { userId: 2, nickname: 'bob', email: 'bob@example.com', contents: 'bob bio', gender: 'M', age: null, image: { imageId: 5, url: 'https://bucket.s3.ap-northeast-2.amazonaws.com/b.png' }, password: 'HASH-B', salt: 'SALT-B' },
    { userId: 3, nickname: 'kakao-user', email: 'kakao@example.com', provider: 'kakao', snsId: '999', password: undefined, salt: undefined }
  );
  tables.Token.push({ id: 1, userId: 1, refreshToken: 'x' });
  tables.Follow.push({ followerId: 1, followingId: 2 }, { followerId: 2, followingId: 1 });
  tables.InterestCategory.push({ interestCategoryId: 7, user: { userId: 1 }, category: tables.Category[0] });
  executedSql.length = 0;
  sqlCounts.ongoingProjects = 0;
  sqlCounts.pendingPayments = 0;
  failInsertWith.code = undefined;
  nextId = 100;
};

const matchValue = (actual: unknown, expected: any): boolean => { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (expected && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && matches(actual as Row, expected);
  }
  return actual === expected;
};
const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => v !== undefined && matchValue(row[k], v));

/** find 옵션의 select를 흉내낸다. select:false 컬럼(password, salt)은 명시했을 때만 나온다. */
const project = (name: string, row: Row, select?: Row): Row => {
  const out: Row = {};
  const pick = (source: Row, sel: Row | undefined, hidden: string[]) => {
    const target: Row = {};
    for (const [k, v] of Object.entries(source)) {
      if (hidden.includes(k) && !(sel && sel[k] === true)) continue;
      if (sel && Object.keys(sel).length > 0 && !(k in sel)) continue;
      if (v && typeof v === 'object' && !(v instanceof Date) && sel && typeof sel[k] === 'object') {
        target[k] = pick(v as Row, sel[k], []);
      } else {
        target[k] = v;
      }
    }
    return target;
  };
  Object.assign(out, pick(row, select, name === 'User' ? ['password', 'salt'] : []));
  return out;
};

const withFollowUsers = (row: Row): Row => ({
  ...row,
  follower: tables.User.find((u) => u.userId === row.followerId),
  following: tables.User.find((u) => u.userId === row.followingId),
});

const repoFor = (name: string) => {
  const rowsOf = () => (name === 'Follow' ? tables.Follow.map(withFollowUsers) : tables[name]);
  return {
    create: (data: Row) => ({ ...data }),
    save: async (data: Row) => {
      const pk = { User: 'userId', Image: 'imageId', InterestCategory: 'interestCategoryId' }[name] ?? 'id';
      const existing = data[pk] !== undefined ? tables[name].find((r) => r[pk] === data[pk]) : undefined;
      if (existing) return Object.assign(existing, data);
      data[pk] = nextId++;
      tables[name].push(data);
      return data;
    },
    insert: async (data: Row) => {
      if (failInsertWith.code) throw Object.assign(new Error('dup'), { driverError: { code: failInsertWith.code } });
      tables[name].push(data);
    },
    findOne: async ({ where, select }: { where: Row; select?: Row }) => {
      const row = rowsOf().find((r) => matches(r, where));
      return row ? project(name, row, select) : null;
    },
    exists: async ({ where }: { where: Row }) => rowsOf().some((r) => matches(r, where)),
    count: async ({ where }: { where: Row }) => rowsOf().filter((r) => matches(r, where)).length,
    findAndCount: async ({ where, select, skip, take }: { where: Row; select?: Row; skip: number; take: number }) => {
      const all = rowsOf().filter((r) => matches(r, where));
      const page = all.slice(skip, skip + take).map((r) => {
        const out = project('Follow', r, select);
        for (const side of ['following', 'follower']) {
          if (select?.[side]) out[side] = project('User', r[side], select[side]);
        }
        return out;
      });
      return [page, all.length];
    },
    delete: async (criteria: Row) => {
      const before = tables[name].length;
      tables[name] = tables[name].filter((r) => !matches(r, criteria));
      return { affected: before - tables[name].length };
    },
    update: async (criteria: Row, values: Row) => {
      for (const r of tables[name].filter((row) => matches(row, criteria))) Object.assign(r, values);
    },
  };
};

const manager = {
  ...{},
  findOne: async (entity: { name: string }, opts: { where: Row; select?: Row }) => repoFor(entity.name).findOne(opts),
  create: (entity: { name: string }, data: Row) => repoFor(entity.name).create(data),
  save: async (a: any, b?: Row) => (typeof a === 'function' ? repoFor(a.name).save(b as Row) : repoFor('User').save(a)), // eslint-disable-line @typescript-eslint/no-explicit-any
  delete: async (entity: { name: string }, criteria: Row) => repoFor(entity.name).delete(criteria),
  update: async (entity: { name: string }, criteria: Row, values: Row) => {
    executedSql.push({ sql: `UPDATE ${entity.name}`, params: [criteria, values] });
    const evaluated = Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, typeof v === 'function' ? `deleted-${criteria.userId}@deleted.invalid` : v])
    );
    return repoFor(entity.name).update(criteria, evaluated);
  },
  query: async (sql: string, params?: unknown[]) => {
    executedSql.push({ sql, params });
    if (sql.includes('FROM project')) return [{ count: String(sqlCounts.ongoingProjects) }];
    if (sql.includes('FROM payment_schedule')) return [{ count: String(sqlCounts.pendingPayments) }];
    if (sql.startsWith('DELETE FROM payment_info') || sql.startsWith('DELETE FROM `like`')) return [];
    return [];
  },
  createQueryBuilder: () => {
    let entity = '';
    const qb = {
      delete: () => qb,
      from: (e: { name: string }) => ((entity = e.name), qb),
      where: (_sql: string, params: { userId: number }) => {
        executedSql.push({ sql: `DELETE ${entity} WHERE user_id`, params: [params.userId] });
        tables[entity] = tables[entity].filter((r) => (r.userId ?? r.user?.userId) !== params.userId);
        return qb;
      },
      execute: async () => undefined,
    };
    return qb;
  },
};

jest.mock('../data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => repoFor(entity.name),
    transaction: async (cb: (m: typeof manager) => Promise<void>) => {
      // 실제 트랜잭션처럼 실패하면 트랜잭션 안의 변경을 되돌린다.
      const snapshot = JSON.stringify(tables);
      try {
        await cb(manager);
      } catch (err) {
        const restored = JSON.parse(snapshot);
        for (const k of Object.keys(tables)) tables[k] = restored[k];
        throw err;
      }
    },
  },
}));

// --- 서버 --------------------------------------------------------------------
let server: Server;
let base: string;

const SERVICES = [
  ['funding-service', 'FUNDING_SERVICE_PORT'],
  ['payment-service', 'PAYMENT_SERVICE_PORT'],
  ['interaction-service', 'INTERACTION_SERVICE_PORT'],
] as const;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.AWS_BUCKET = 'bucket';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);

  for (const [name, envName] of SERVICES) {
    const upstream = http.createServer((req, res) => {
      const rec: Received = { service: name, method: req.method ?? '', url: req.url ?? '', headers: req.headers };
      received.push(rec);
      const custom = responders[name]?.(rec);
      const { status, body } = custom ?? { status: 200, body: name === 'payment-service' ? { count: 4 } : name === 'interaction-service' ? { likeCount: 2, commentCount: 3 } : [{ project_id: 1 }] };
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    upstreams.push(upstream);
    process.env[envName] = String(await listen(upstream));
  }

  const { headerToLocals, errorHandler } = await import('@shared/config');
  const userRouter = (await import('../routes/users')).default;
  const app = express();
  app.use(express.json({ limit: '20kb' }));
  app.use(headerToLocals);
  app.use('/users', userRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  for (const s of [server, ...upstreams]) await new Promise((resolve) => s.close(resolve));
});

beforeEach(async () => {
  resetDb();
  received.length = 0;
  for (const k of Object.keys(responders)) delete responders[k];
  // alice(1)의 비밀번호는 실제 해시로 준비
  const { hashPassword } = await import('@shared/config');
  Object.assign(tables.User[0], await hashPassword('Passw0rd!x'));
});

const call = async (method: string, path: string, opts: { user?: number; body?: unknown; raw?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.user) headers['x-user-id'] = String(opts.user);
  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { status: res.status, body, text, setCookie: res.headers.getSetCookie() };
};

// --- H1 ----------------------------------------------------------------------
describe('H1: 비로그인 요청', () => {
  const protectedRoutes: [string, string][] = [
    ['DELETE', '/users/account'],
    ['GET', '/users/mypage'],
    ['GET', '/users/mypage/profile'],
    ['PUT', '/users/mypage/profile'],
    ['GET', '/users/mypage/payments'],
    ['GET', '/users/mypage/comments'],
    ['GET', '/users/projects'],
    ['GET', '/users/projects/statistics'],
    ['GET', '/users/projects/payments'],
    ['POST', '/users/following'],
    ['DELETE', '/users/following'],
    ['GET', '/users/mypage/following'],
    ['GET', '/users/mypage/follower'],
  ];

  it.each(protectedRoutes)('%s %s → 401이고 서비스는 살아 있다', async (method, path) => {
    expect((await call(method, path, { body: method === 'GET' ? undefined : {} })).status).toBe(401);
    expect((await call('GET', '/users/maker/2')).status).toBe(200);
  });

  it('공개 프로필은 로그인 없이 조회된다', async () => {
    expect((await call('GET', '/users/maker/2')).status).toBe(200);
    expect((await call('GET', '/users/supporter/2')).status).toBe(200);
  });
});

// --- H2 회원 탈퇴 -----------------------------------------------------------------
describe('H2: 회원 탈퇴', () => {
  it('비밀번호가 틀리면 401, 없으면 400이며 아무것도 지우지 않는다', async () => {
    expect((await call('DELETE', '/users/account', { user: 1, body: { password: 'wrong-password' } })).status).toBe(401);
    expect((await call('DELETE', '/users/account', { user: 1, body: {} })).status).toBe(400);
    expect((await call('DELETE', '/users/account', { user: 1, body: { password: { a: 1 } } })).status).toBe(400);
    expect(tables.User[0].nickname).toBe('alice');
    expect(tables.Token).toHaveLength(1);
  });

  it('성공하면 사용자 행은 익명화되고 로그인 수단과 개인 정보는 삭제된다', async () => {
    const res = await call('DELETE', '/users/account', { user: 1, body: { password: 'Passw0rd!x' } });
    expect(res.status).toBe(200);

    const user = tables.User[0];
    expect(user.nickname).toBe('탈퇴한 사용자');
    expect(user.email).toBe('deleted-1@deleted.invalid');
    expect([user.password, user.salt, user.contents, user.gender, user.image, user.age, user.snsId]).toEqual(Array(7).fill(null));

    expect(tables.Token).toHaveLength(0);
    expect(tables.InterestCategory).toHaveLength(0);
    expect(tables.Follow).toHaveLength(0);
    expect(executedSql.some((q) => q.sql.startsWith('DELETE FROM payment_info'))).toBe(true);
    expect(executedSql.some((q) => q.sql.startsWith('DELETE FROM `like`'))).toBe(true);
    expect(res.setCookie.filter((c) => /^(accessToken|refreshToken)=;/.test(c))).toHaveLength(2);
  });

  it('refresh 토큰 헤더 없이도 탈퇴할 수 있다', async () => {
    expect((await call('DELETE', '/users/account', { user: 1, body: { password: 'Passw0rd!x' } })).status).toBe(200);
  });

  it('소셜 계정(비밀번호 없음)은 가입 이메일을 입력해 탈퇴한다', async () => {
    expect((await call('DELETE', '/users/account', { user: 3, body: {} })).status).toBe(400);
    expect((await call('DELETE', '/users/account', { user: 3, body: { email: 'other@example.com' } })).status).toBe(401);
    expect((await call('DELETE', '/users/account', { user: 3, body: { email: 'KAKAO@example.com' } })).status).toBe(200);
    expect(tables.User[2].nickname).toBe('탈퇴한 사용자');
  });

  it('진행 중인 프로젝트나 결제 예정이 있으면 409이고 아무것도 바뀌지 않는다', async () => {
    sqlCounts.ongoingProjects = 1;
    const a = await call('DELETE', '/users/account', { user: 1, body: { password: 'Passw0rd!x' } });
    expect(a.status).toBe(409);
    sqlCounts.ongoingProjects = 0;
    sqlCounts.pendingPayments = 2;
    const b = await call('DELETE', '/users/account', { user: 1, body: { password: 'Passw0rd!x' } });
    expect(b.status).toBe(409);
    expect(tables.User[0].nickname).toBe('alice');
    expect(tables.Token).toHaveLength(1);
    expect(executedSql.some((q) => q.sql.startsWith('DELETE'))).toBe(false);
  });

  it('비밀번호를 5번 틀리면 이후에는 맞아도 429', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call('DELETE', '/users/account', { user: 1, body: { password: 'wrong-password' } })).status).toBe(401);
    }
    expect((await call('DELETE', '/users/account', { user: 1, body: { password: 'Passw0rd!x' } })).status).toBe(429);
  });
});

// --- M1 프로필 수정 ------------------------------------------------------------------
describe('M1: 프로필 수정', () => {
  const put = (body: unknown) => call('PUT', '/users/mypage/profile', { user: 1, body });

  it('age_id/category_id를 보내지 않으면 기존 값이 유지된다(첫 번째 행으로 바뀌지 않음)', async () => {
    tables.User[0].age = tables.Age[1];
    tables.InterestCategory[0].category = tables.Category[1];
    expect((await put({ nickname: '새이름' })).status).toBe(200);
    expect(tables.User[0].nickname).toBe('새이름');
    expect(tables.User[0].age.ageId).toBe(2);
    expect(tables.InterestCategory[0].category.categoryId).toBe(2);
  });

  it('잘못된 값은 400이고 어떤 필드도 저장되지 않는다(부분 저장 없음)', async () => {
    const bad = await put({ nickname: '바뀌면안됨', age_id: 2, category_id: 999 });
    expect(bad.status).toBe(400);
    expect(tables.User[0].nickname).toBe('alice');
    expect(tables.User[0].age.ageId).toBe(1);
  });

  it.each([
    ['nickname null', { nickname: null }],
    ['nickname 빈 문자열', { nickname: '  ' }],
    ['nickname 46자', { nickname: 'a'.repeat(46) }],
    ['nickname 숫자', { nickname: 5 }],
    ['gender 6자', { gender: 'female' }],
    ['contents 2001자', { contents: 'a'.repeat(2001) }],
    ['age_id 문자열', { age_id: 'abc' }],
    ['age_id 0', { age_id: 0 }],
    ['category_id 객체', { category_id: {} }],
    ['외부 이미지', { image_url: 'https://evil.example.com/pixel.png' }],
    ['http 이미지', { image_url: 'http://bucket.s3.ap-northeast-2.amazonaws.com/a.png' }],
    ['javascript 이미지', { image_url: 'javascript:alert(1)' }],
    ['너무 긴 이미지 주소', { image_url: `https://bucket.s3.ap-northeast-2.amazonaws.com/${'a'.repeat(300)}` }],
  ])('%s → 400', async (_name, body) => {
    expect((await put(body)).status).toBe(400);
    expect(tables.User[0].nickname).toBe('alice');
  });

  it('우리 버킷의 이미지 주소는 저장되고 null이면 삭제된다', async () => {
    const url = 'https://bucket.s3.ap-northeast-2.amazonaws.com/uploads/1/a.png';
    expect((await put({ image_url: url })).status).toBe(200);
    expect(tables.User[0].image.url).toBe(url);
    expect((await put({ image_url: null })).status).toBe(200);
    expect(tables.User[0].image).toBeNull();
  });

  it('소셜 가입 사용자(관심 카테고리 없음)도 카테고리가 저장된다', async () => {
    const res = await call('PUT', '/users/mypage/profile', { user: 3, body: { category_id: 2 } });
    expect(res.status).toBe(200);
    const created = tables.InterestCategory.find((r) => r.user.userId === 3);
    expect(created?.category.categoryId).toBe(2);
  });

  it('존재하지 않는 연령은 400', async () => {
    expect((await put({ age_id: 99 })).status).toBe(400);
  });
});

// --- M2 ----------------------------------------------------------------------
describe('M2: 프로필 조회', () => {
  it('interestCategory는 categories의 ID(수정 API가 받는 값)이며 해시는 없다', async () => {
    tables.InterestCategory[0].interestCategoryId = 7;
    tables.InterestCategory[0].category = tables.Category[1];
    const res = await call('GET', '/users/mypage/profile', { user: 1 });
    expect(res.status).toBe(200);
    expect(res.body.interestCategory).toBe(2);
    expect(res.body.categoryId).toBe(2);
    expect(res.body.categoryName).toBe('푸드');
    expect(res.text).not.toMatch(/HASH|salt|password/i);
  });
});

// --- M3 다른 서비스 호출 ---------------------------------------------------------------
describe('M3: 다른 서비스 호출', () => {
  const urlOf = (service: string) => received.find((r) => r.service === service)?.url ?? '';

  it('마이페이지: 프로젝트 ID를 반복 파라미터로 보내고 사용자 헤더를 붙인다', async () => {
    const res = await call('GET', '/users/mypage?project_id=1,2&project_id=3&project_id=abc&project_id=1', { user: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ followingCount: 1, followerCount: 1, paymentCount: 4, likeCount: 2, commentCount: 3 });
    const url = decodeURIComponent(urlOf('funding-service'));
    expect(url).toContain('/api/projects/recent?');
    expect(url.match(/project_id\[\]=/g)).toHaveLength(3);
    expect(received.every((r) => r.headers['x-user-id'] === '1')).toBe(true);
  });

  it('project_id가 없으면 funding-service를 호출하지 않는다', async () => {
    await call('GET', '/users/mypage', { user: 1 });
    expect(received.some((r) => r.service === 'funding-service')).toBe(false);
  });

  it('한 서비스가 실패해도 나머지는 내려주고 실패한 항목만 비운다', async () => {
    responders['payment-service'] = () => ({ status: 500, body: { message: 'boom' } });
    const res = await call('GET', '/users/mypage?project_id=1', { user: 1 });
    expect(res.status).toBe(200);
    expect(res.body.paymentCount).toBe(0);
    expect(res.body.likeCount).toBe(2);
    expect(res.body.degraded).toEqual(['payment']);
  });

  it('통계: start/end를 payment-service의 startDate/endDate로 바꿔 params로 전달한다', async () => {
    responders['funding-service'] = () => ({ status: 200, body: [{ id: 1 }, { id: 2 }] });
    responders['payment-service'] = () => ({ status: 200, body: { totalAmount: 10 } });
    const res = await call('GET', '/users/projects/statistics?start=2026-01-01&end=2026-01-31', { user: 1 });
    expect(res.body).toEqual({ fundingCount: 2, statistic: { totalAmount: 10 } });
    expect(urlOf('payment-service')).toBe('/statistics/summary?startDate=2026-01-01&endDate=2026-01-31');
  });

  it('통계: 날짜 형식이 아니면 400이고 파라미터 주입도 불가능하다', async () => {
    for (const q of ['start=abc&end=2026-01-01', 'start=2026-01-01%26x%3Dy&end=2026-01-02', 'start[]=1']) {
      expect((await call('GET', `/users/projects/statistics?${q}`, { user: 1 })).status).toBe(400);
    }
    expect(received).toHaveLength(0);
  });

  it('결제 내역: page/limit이 없으면 기본값을 params로 보낸다(문자열 undefined 없음)', async () => {
    await call('GET', '/users/projects/payments', { user: 1 });
    expect(urlOf('payment-service')).toBe('/statistics/history?page=1&limit=10');
    received.length = 0;
    await call('GET', '/users/projects/payments?page=2&limit=5000', { user: 1 });
    expect(urlOf('payment-service')).toBe('/statistics/history?page=2&limit=100');
  });

  it('예약이 없어 404를 받으면 빈 목록으로 응답한다', async () => {
    responders['payment-service'] = () => ({ status: 404, body: { message: '예약 없음' } });
    const res = await call('GET', '/users/mypage/payments', { user: 1 });
    expect([res.status, res.body]).toEqual([200, []]);
  });

  it('다른 서비스의 4xx는 그 상태로, 5xx는 502로 전달한다', async () => {
    responders['payment-service'] = () => ({ status: 400, body: { message: '잘못된 요청' } });
    const a = await call('GET', '/users/projects/payments', { user: 1 });
    expect([a.status, a.body.message]).toEqual([400, '잘못된 요청']);

    responders['payment-service'] = () => ({ status: 500, body: { message: 'boom' } });
    expect((await call('GET', '/users/projects/payments', { user: 1 })).status).toBe(502);
  });

  it('내가 만든 프로젝트: 두 호출을 함께 처리한다', async () => {
    responders['funding-service'] = (r) => ({ status: 200, body: r.url.includes('recent-completed') ? ['done'] : ['list'] });
    const res = await call('GET', '/users/projects', { user: 1 });
    expect(res.body).toEqual({ completedFunding: ['done'], fundingList: ['list'] });
  });

  it('후기 목록: page와 limit을 둘 다 보낼 때만 params를 붙인다', async () => {
    await call('GET', '/users/mypage/comments', { user: 1 });
    expect(urlOf('funding-service')).toBe('/profiles/my-comments');
    received.length = 0;
    await call('GET', '/users/mypage/comments?page=2&limit=5', { user: 1 });
    expect(urlOf('funding-service')).toBe('/profiles/my-comments?page=2&limit=5');
  });

  it('메이커 프로필: 다른 사용자의 신원 헤더 없이 funding-service를 호출한다', async () => {
    await call('GET', '/users/maker/2');
    expect(received[0].headers['x-user-id']).toBeUndefined();
  });
});

// --- M4 서포터 프로필 -------------------------------------------------------------------
describe('M4: 서포터 프로필', () => {
  it('다른 사람에게는 후원 건수를 주지 않고 payment-service도 호출하지 않는다', async () => {
    const anon = await call('GET', '/users/supporter/2');
    expect(anon.body.paymentCount).toBeNull();
    const other = await call('GET', '/users/supporter/2', { user: 1 });
    expect(other.body.paymentCount).toBeNull();
    expect(received.some((r) => r.service === 'payment-service')).toBe(false);
  });

  it('본인이 보면 후원 건수를 준다', async () => {
    const own = await call('GET', '/users/supporter/2', { user: 2 });
    expect(own.body.paymentCount).toBe(4);
    expect(received[0].headers['x-user-id']).toBe('2');
  });

  it('공개 프로필에는 이메일과 해시가 없다', async () => {
    const res = await call('GET', '/users/supporter/2');
    expect(res.text).not.toMatch(/bob@example|HASH|SALT|email/i);
    expect(Object.keys(res.body).sort()).toEqual(
      ['contents', 'followerCount', 'followingCount', 'imageId', 'imageUrl', 'nickname', 'paymentCount']
    );
  });
});

// --- M5/M6 팔로우 -----------------------------------------------------------------------
describe('M5/M6: 팔로우', () => {
  const follow = (following_id: unknown, method = 'POST', user = 1) =>
    call(method, '/users/following', { user, body: { following_id } });

  it('문자열/숫자 어떤 형태로도 자기 자신은 팔로우할 수 없다', async () => {
    for (const id of [1, '1', ' 1 ']) expect((await follow(id)).status).toBe(400);
    expect((await follow('1', 'DELETE')).status).toBe(400);
  });

  it.each([['abc'], [0], [-1], [1.5], [null], [undefined], [[2]], [{ a: 1 }], ['1e3']])('잘못된 ID(%p) → 400', async (id) => {
    expect((await follow(id)).status).toBe(400);
  });

  it('없는 사용자 404, 이미 팔로우 409, 동시 요청으로 인한 중복 삽입도 409', async () => {
    expect((await follow(99)).status).toBe(404);
    expect((await follow(2)).status).toBe(409);

    tables.Follow = [];
    failInsertWith.code = 'ER_DUP_ENTRY';
    expect((await follow('3')).status).toBe(409);
  });

  it('팔로우/언팔로우 성공, 하지 않은 사용자 언팔로우는 404', async () => {
    expect((await follow('3')).status).toBe(201);
    expect(tables.Follow.some((f) => f.followerId === 1 && f.followingId === 3)).toBe(true);
    expect((await follow('3', 'DELETE')).status).toBe(200);
    expect((await follow('3', 'DELETE')).status).toBe(404);
  });

  it('목록: 공개 필드만 있고 페이지네이션이 적용된다', async () => {
    tables.Follow.push({ followerId: 1, followingId: 3 });
    const res = await call('GET', '/users/mypage/following?limit=1&page=1', { user: 1 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.following).toHaveLength(1);
    expect(Object.keys(res.body.following[0]).sort()).toEqual(['imageId', 'imageUrl', 'nickname', 'userId']);
    expect(res.text).not.toMatch(/HASH|SALT|email/i);

    const followers = await call('GET', '/users/mypage/follower', { user: 1 });
    expect(followers.body.follower.map((f: Row) => f.nickname)).toEqual(['bob']);
  });
});

describe('L: 설정', () => {
  it('data-source 설정에서 logging: true 를 쓰지 않는다', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../data-source.ts'), 'utf8');
    expect(src).not.toMatch(/logging:\s*true/);
  });

  it('잘못된 JSON은 400, 사용자 ID가 유효하지 않은 공개 프로필은 400', async () => {
    expect((await call('PUT', '/users/mypage/profile', { user: 1, raw: '{"a":' })).status).toBe(400);
    expect((await call('GET', '/users/maker/abc')).status).toBe(400);
    expect((await call('GET', '/users/maker/999')).status).toBe(404);
  });
});
