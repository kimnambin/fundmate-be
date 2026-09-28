import 'reflect-metadata';
import http, { Server } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { DataSource, DeleteQueryBuilder, SelectQueryBuilder } from 'typeorm';

/**
 * 실제 라우터/컨트롤러/전역 에러 핸들러와 실제 TypeORM 쿼리 빌더를 사용한다.
 * MySQL에 연결하지 않고, 쿼리 빌더가 실행하려는 SQL과 파라미터를 가로채서 검사하고 준비한 행을 돌려준다.
 */

interface Captured {
  kind: string;
  sql: string;
  params: unknown[];
}

let mockDs: DataSource;
jest.mock('../data-source', () => ({
  get AppDataSource() {
    return mockDs;
  },
}));

const captured: Captured[] = [];
/** kind별로 돌려줄 값. 함수면 캡처한 SQL을 보고 결정한다. */
let answers: Partial<Record<'rawMany' | 'rawOne' | 'one' | 'count' | 'exists' | 'execute' | 'query', unknown>> = {};

const norm = (sql: string) => sql.replace(/\s+/g, ' ').replace(/`/g, '');
const answer = (kind: keyof typeof answers, c: Captured) => {
  const a = answers[kind];
  return typeof a === 'function' ? (a as (c: Captured) => unknown)(c) : a;
};

const spyOnBuilder = (kind: keyof typeof answers, target: object, method: string, fallback: unknown) =>
  jest.spyOn(target as never, method as never).mockImplementation(function (this: SelectQueryBuilder<never>) {
    const [sql, params] = this.getQueryAndParameters();
    const c = { kind, sql: norm(sql), params };
    captured.push(c);
    return Promise.resolve(answers[kind] === undefined ? fallback : answer(kind, c));
  } as never);

// 트랜잭션용 가짜 러너
const runnerState = { connectFails: false, released: 0, committed: 0, rolledBack: 0, active: false, saved: [] as unknown[][], categoryExists: true };
const fakeRunner = () => ({
  connect: async () => {
    if (runnerState.connectFails) throw new Error('db down');
  },
  startTransaction: async () => {
    runnerState.active = true;
  },
  commitTransaction: async () => {
    runnerState.active = false;
    runnerState.committed++;
  },
  rollbackTransaction: async () => {
    runnerState.active = false;
    runnerState.rolledBack++;
  },
  release: async () => {
    runnerState.released++;
  },
  get isTransactionActive() {
    return runnerState.active;
  },
  manager: {
    exists: async () => runnerState.categoryExists,
    create: (_entity: unknown, data: Record<string, unknown>) => ({ ...data }),
    save: async (data: unknown) => {
      if (Array.isArray(data)) {
        runnerState.saved.push(data);
        return data;
      }
      runnerState.saved.push([data]);
      return { ...(data as object), projectId: 77 };
    },
  },
});

let server: Server;
let base: string;

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  process.env.AWS_BUCKET = 'bucket';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);

  const { fundingEntities } = await import('@shared/entities');
  mockDs = new DataSource({ type: 'mysql', database: 'test', entities: fundingEntities });
  await (mockDs as unknown as { buildMetadatas(): Promise<void> }).buildMetadatas();
  (mockDs as unknown as { createQueryRunner: unknown }).createQueryRunner = fakeRunner;
  (mockDs as unknown as { query: unknown }).query = jest.fn(async (sql: string, params: unknown[]) => {
    const c = { kind: 'query', sql: norm(sql), params };
    captured.push(c);
    return answer('query', c) ?? [{ used: 0, started: 0 }];
  });

  spyOnBuilder('rawMany', SelectQueryBuilder.prototype, 'getRawMany', []);
  spyOnBuilder('rawOne', SelectQueryBuilder.prototype, 'getRawOne', undefined);
  spyOnBuilder('one', SelectQueryBuilder.prototype, 'getOne', null);
  spyOnBuilder('count', SelectQueryBuilder.prototype, 'getCount', 0);
  spyOnBuilder('exists', SelectQueryBuilder.prototype, 'getExists', false);
  spyOnBuilder('execute', DeleteQueryBuilder.prototype, 'execute', { affected: 1 });

  const { headerToLocals, errorHandler } = await import('@shared/config');
  const app = express();
  app.use(express.json({ limit: '200kb' }));
  app.use(headerToLocals);
  app.use('/projects', (await import('../routes/FundingRouter')).default);
  app.use('/options', (await import('../routes/OptionRouter')).default);
  app.use('/api/projects', (await import('../routes/MainRouter')).default);
  app.use('/profiles', (await import('../routes/ProfileRouter')).default);
  app.use(errorHandler);

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  captured.length = 0;
  answers = {};
  Object.assign(runnerState, { connectFails: false, released: 0, committed: 0, rolledBack: 0, active: false, saved: [], categoryExists: true });
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
  return { status: res.status, body, text };
};

const sqlOf = (kind: string) => captured.find((c) => c.kind === kind);

// --- H1/H2 ----------------------------------------------------------------------
describe('H1/H2: 인증과 옵션 삭제', () => {
  const protectedRoutes: [string, string][] = [
    ['POST', '/projects'],
    ['DELETE', '/options/1'],
    ['GET', '/profiles/recent-completed'],
    ['GET', '/profiles/my-projects'],
    ['GET', '/profiles/my-comments'],
  ];

  it.each(protectedRoutes)('%s %s → 비로그인은 401이고 서비스는 살아 있고 DB를 건드리지 않는다', async (method, path) => {
    expect((await call(method, path, { body: method === 'POST' ? {} : undefined })).status).toBe(401);
    expect((await call('GET', '/profiles/7')).status).toBe(200);
    expect(captured.filter((c) => c.kind !== 'rawMany')).toHaveLength(0);
  });

  const option = (ownerId: number) => ({ optionId: 5, project: { projectId: 9, user: { userId: ownerId } } });

  it('없는 옵션은 404, 남의 옵션은 403이며 삭제하지 않는다', async () => {
    expect((await call('DELETE', '/options/5', { user: 1 })).status).toBe(404);

    answers.one = option(2);
    expect((await call('DELETE', '/options/5', { user: 1 })).status).toBe(403);
    expect(captured.some((c) => c.kind === 'execute')).toBe(false);
  });

  it('내 옵션은 삭제된다', async () => {
    answers.one = option(1);
    const res = await call('DELETE', '/options/5', { user: 1 });
    expect(res.status).toBe(200);
    const del = sqlOf('execute');
    expect(del?.sql).toContain('DELETE FROM option_data WHERE option_id = ?');
    expect(del?.params).toEqual([5]);
  });

  it('이미 시작된 프로젝트나 후원에 쓰인 옵션은 409', async () => {
    answers.one = option(1);
    answers.query = [{ used: 0, started: 1 }];
    expect((await call('DELETE', '/options/5', { user: 1 })).status).toBe(409);
    answers.query = [{ used: 3, started: 0 }];
    expect((await call('DELETE', '/options/5', { user: 1 })).status).toBe(409);
    expect(captured.some((c) => c.kind === 'execute')).toBe(false);
  });

  it.each(['abc', '0', '-1', '1.5'])('잘못된 옵션 ID(%s) → 400', async (id) => {
    expect((await call('DELETE', `/options/${id}`, { user: 1 })).status).toBe(400);
  });
});

// --- M1 ----------------------------------------------------------------------------
describe('M1: 상세/집계', () => {
  const row = {
    project_id: 1, project_image_url: 'u', title: 't', current_price: 10, remaining_day: '3', goal_amount: 100,
    start_date: '2026-01-01', end_date: '2026-02-01', delivery_date: '2026-03-01', description: 'd',
    user_image_id: 2, nickname: 'n', content: 'c', payment_date: '2026-02-02', sponsor: '5', likes: '3', liked: '1',
  };

  it('후원자/좋아요 수는 서브쿼리로 세고 like·payment_schedule을 조인하지 않는다', async () => {
    answers.rawOne = row;
    answers.rawMany = [{ title: 'o', description: 'd', price: 1000 }];
    const res = await call('GET', '/projects/1', { user: 4 });
    expect(res.status).toBe(200);
    expect(res.body.project).toMatchObject({ sponsor: 5, likes: 3, liked: true, remaining_day: 3 });
    expect(res.body.options).toEqual([{ title: 'o', description: 'd', price: 1000 }]);

    const sql = sqlOf('rawOne')!.sql;
    expect(sql).not.toMatch(/LEFT JOIN (payment_schedule|like)/i);
    expect(sql).toContain('(SELECT COUNT(DISTINCT s.user_id) FROM payment_schedule s WHERE s.project_id = project.project_id) AS sponsor');
    expect(sql).toContain('(SELECT COUNT(*) FROM like l WHERE l.project_id = project.project_id) AS likes');
    expect(sql).not.toContain('CONVERT_TZ');
    expect(sql).not.toMatch(/GROUP BY/i);
  });

  it('없는 프로젝트는 404, 잘못된 ID는 400', async () => {
    answers.rawOne = undefined;
    expect((await call('GET', '/projects/999')).status).toBe(404);
    for (const id of ['abc', '0', '-2', '1.5']) expect((await call('GET', `/projects/${id}`)).status).toBe(400);
  });

  it('비로그인이면 liked는 항상 false(다른 사용자의 좋아요 상태가 섞이지 않음)', async () => {
    answers.rawOne = { ...row, liked: '0' };
    const res = await call('GET', '/projects/1');
    expect(res.body.project.liked).toBe(false);
    expect(sqlOf('rawOne')!.sql).toContain('0 AS liked');
  });

  it('최근 완료: 종료된 내 프로젝트를 프로젝트마다 한 행으로, 배열로 돌려준다', async () => {
    answers.rawMany = [
      { project_id: 1, project_title: 'a', achievement: '120', sponsor: '4', current_amount: '500' },
      { project_id: 2, project_title: 'b', achievement: '10', sponsor: '1', current_amount: '50' },
    ];
    const res = await call('GET', '/profiles/recent-completed', { user: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({ achievement: 120, sponsor: 4, current_amount: 500 });

    const { sql, params } = sqlOf('rawMany')!;
    expect(sql).toContain('project.end_date < CURDATE()');
    expect(sql).not.toContain('is_active');
    expect(sql).not.toMatch(/LEFT JOIN/i);
    expect(sql).toContain('ORDER BY project.end_date DESC');
    expect(params).toContain(3);
  });

  it('종료된 프로젝트가 없으면 빈 배열(undefined 처리 오류 없음)', async () => {
    const res = await call('GET', '/profiles/recent-completed', { user: 3 });
    expect([res.status, res.body]).toEqual([200, []]);
  });
});

// --- M2 ----------------------------------------------------------------------------
describe('M2: 프로젝트 생성', () => {
  const future = (days: number) => new Date(Date.now() + (9 * 3600 + days * 86400) * 1000).toISOString().slice(0, 10);
  const valid = () => ({
    image_url: 'https://bucket.s3.ap-northeast-2.amazonaws.com/uploads/1/a.png',
    title: '프로젝트',
    goal_amount: 100000,
    start_date: future(1),
    end_date: future(30),
    delivery_date: future(60),
    short_description: '짧은 설명',
    description: '긴 설명',
    category_id: 1,
    gender: 0,
    age_group: 0,
    options: [
      { title: '옵션1', description: '설명1', price: 1000 },
      { title: '옵션2', description: '설명2', price: 5000 },
    ],
  });

  it('정상 요청: 프로젝트와 옵션이 한 트랜잭션으로 저장되고 옵션은 한 번에 저장된다', async () => {
    const res = await call('POST', '/projects', { user: 1, body: valid() });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ project_id: 77 });
    expect([runnerState.committed, runnerState.rolledBack, runnerState.released]).toEqual([1, 0, 1]);
    expect(runnerState.saved[1]).toHaveLength(2); // 옵션 배열
  });

  it.each([
    ['목표 금액 0', { goal_amount: 0 }],
    ['목표 금액 음수', { goal_amount: -5 }],
    ['목표 금액 문자열', { goal_amount: '1000' }],
    ['목표 금액 소수', { goal_amount: 10.5 }],
    ['목표 금액 int 초과', { goal_amount: 3_000_000_000 }],
    ['제목 31자', { title: 'a'.repeat(31) }],
    ['제목 공백', { title: '   ' }],
    ['짧은 설명 46자', { short_description: 'a'.repeat(46) }],
    ['종료일이 시작일보다 앞', { end_date: future(0) }],
    ['배송일이 종료일보다 앞', { delivery_date: future(10) }],
    ['이미 지난 시작일', { start_date: '2000-01-01' }],
    ['존재하지 않는 날짜', { start_date: '2099-02-31' }],
    ['날짜 형식 오류', { end_date: '내일' }],
    ['옵션이 문자열', { options: 'abc' }],
    ['옵션이 객체', { options: { title: 'x' } }],
    ['옵션이 비어 있음', { options: [] }],
    ['옵션 21개', { options: Array.from({ length: 21 }, () => ({ title: 't', description: 'd', price: 1 })) }],
    ['옵션 가격 음수', { options: [{ title: 't', description: 'd', price: -1 }] }],
    ['옵션 가격 소수', { options: [{ title: 't', description: 'd', price: 1.5 }] }],
    ['옵션 제목 31자', { options: [{ title: 'a'.repeat(31), description: 'd', price: 1 }] }],
    ['옵션 설명 151자', { options: [{ title: 't', description: 'a'.repeat(151), price: 1 }] }],
    ['옵션 항목이 null', { options: [null] }],
    ['외부 이미지', { image_url: 'https://evil.example.com/x.png' }],
    ['이미지 없음', { image_url: undefined }],
    ['카테고리 문자열', { category_id: 'abc' }],
  ])('%s → 400이고 DB 트랜잭션을 시작하지 않는다', async (_name, patch) => {
    const res = await call('POST', '/projects', { user: 1, body: { ...valid(), ...patch } });
    expect(res.status).toBe(400);
    expect(runnerState.released).toBe(0);
    expect(runnerState.saved).toHaveLength(0);
  });

  it('존재하지 않는 카테고리는 400이고 롤백된다', async () => {
    runnerState.categoryExists = false;
    const res = await call('POST', '/projects', { user: 1, body: valid() });
    expect(res.status).toBe(400);
    expect([runnerState.committed, runnerState.rolledBack, runnerState.released]).toEqual([0, 1, 1]);
  });

  it('DB 연결이 실패해도 프로세스가 종료되지 않고 500, 연결은 해제된다', async () => {
    runnerState.connectFails = true;
    const res = await call('POST', '/projects', { user: 1, body: valid() });
    expect(res.status).toBe(500);
    expect(runnerState.released).toBe(1);
    expect((await call('GET', '/profiles/7')).status).toBe(200);
  });

  it('title이 없는 경우처럼 본문이 비어도 500이 아니라 400', async () => {
    expect((await call('POST', '/projects', { user: 1, body: {} })).status).toBe(400);
    expect((await call('POST', '/projects', { user: 1, raw: '{"a":' })).status).toBe(400);
  });
});

// --- M4 ----------------------------------------------------------------------------
describe('M4: 목록', () => {
  it('마감 임박: 진행 중인 프로젝트를 종료일이 가까운 순으로', async () => {
    await call('GET', '/api/projects/deadline');
    const { sql } = sqlOf('rawMany')!;
    expect(sql).toContain('project.start_date <= CURDATE() AND project.end_date >= CURDATE()');
    expect(sql).toContain('ORDER BY project.end_date ASC, project.project_id DESC');
  });

  it('기본 목록은 종료된 프로젝트를 제외하고 status로 바꿀 수 있다', async () => {
    await call('GET', '/api/projects');
    expect(sqlOf('rawMany')!.sql).toContain('project.end_date >= CURDATE()');

    captured.length = 0;
    await call('GET', '/api/projects?status=ended');
    expect(sqlOf('rawMany')!.sql).toContain('project.end_date < CURDATE()');

    captured.length = 0;
    await call('GET', '/api/projects?status=all');
    expect(sqlOf('rawMany')!.sql).not.toContain('CURDATE() AND');
    expect(sqlOf('rawMany')!.sql).not.toMatch(/WHERE/);

    expect((await call('GET', '/api/projects?status=weird')).status).toBe(400);
    expect((await call('GET', '/api/projects?status[]=x')).status).toBe(400);
  });

  it('페이지네이션: 기본 50, 최대 100, page로 OFFSET', async () => {
    await call('GET', '/api/projects');
    expect(sqlOf('rawMany')!.sql).toMatch(/LIMIT 50 OFFSET 0$/);

    captured.length = 0;
    await call('GET', '/api/projects?limit=1000&page=3');
    expect(sqlOf('rawMany')!.sql).toMatch(/LIMIT 100 OFFSET 200$/);

    captured.length = 0;
    await call('GET', '/api/projects?limit=abc&page=-3');
    expect(sqlOf('rawMany')!.sql).toMatch(/LIMIT 50 OFFSET 0$/);
  });

  it('신규: 등록 후 지난 일수는 0 이상이 되도록 계산하고 최신순', async () => {
    answers.rawMany = [{ project_id: 1, created_before: '2', achievement: '5', remaining_day: '9', current_amount: '1', goal_amount: '2' }];
    const res = await call('GET', '/api/projects/new');
    const { sql } = sqlOf('rawMany')!;
    expect(sql).toContain('DATEDIFF(CURDATE(), DATE(project.created_at)) AS created_before');
    expect(sql).toContain('ORDER BY project.created_at DESC, project.project_id DESC');
    expect(res.body[0]).toMatchObject({ created_before: 2, achievement: 5, remaining_day: 9 });
  });

  it('인기: limit을 따르고 진행 중인 프로젝트를 좋아요 순으로', async () => {
    await call('GET', '/api/projects/popular?limit=3');
    const { sql } = sqlOf('rawMany')!;
    expect(sql).toContain('project.end_date >= CURDATE()');
    expect(sql).toMatch(/ORDER BY like_count DESC, project.project_id DESC LIMIT 3$/);
    expect(sql).toContain('(SELECT COUNT(*) FROM like l WHERE l.project_id = project.project_id) AS like_count');
    captured.length = 0;
    await call('GET', '/api/projects/popular');
    expect(sqlOf('rawMany')!.sql).toMatch(/LIMIT 8$/);
  });

  it('카테고리: 숫자가 아니면 500이 아니라 400, 유효하면 파라미터로 필터', async () => {
    for (const id of ['abc', '0', '-1', '1.5']) expect((await call('GET', `/api/projects/${id}`)).status).toBe(400);
    await call('GET', '/api/projects/3');
    const { sql, params } = sqlOf('rawMany')!;
    expect(sql).toContain('project.category_id = ?');
    expect(params).toContain(3);
  });

  it('achievement가 없는 행(목표 0)도 숫자로 내려준다', async () => {
    answers.rawMany = [{ project_id: 1, achievement: '0', remaining_day: '0', current_amount: '0', goal_amount: '0' }];
    const res = await call('GET', '/api/projects');
    expect(res.body[0].achievement).toBe(0);
    expect(sqlOf('rawMany')!.sql).toContain('COALESCE(FLOOR(project.current_amount / NULLIF(project.goal_amount, 0) * 100), 0) AS achievement');
  });
});

// --- M5 ----------------------------------------------------------------------------
describe('M5: 최근 본 프로젝트', () => {
  it('반복 파라미터, 쉼표 구분 모두 정수 배열로 바꿔 IN 조회하고 입력 순서를 유지한다', async () => {
    await call('GET', '/api/projects/recent?project_id[]=3&project_id[]=1&project_id=2,3');
    const { sql, params } = sqlOf('rawMany')!;
    expect(sql).toMatch(/project_id IN \(\?, \?, \?\)/);
    expect(sql).toMatch(/ORDER BY FIELD\(project.project_id, \?, \?, \?\)/);
    expect(params).toEqual([3, 1, 2, 3, 1, 2]);
  });

  it('숫자가 아닌 값은 버리고 없으면 DB를 조회하지 않는다', async () => {
    const empty = await call('GET', '/api/projects/recent?project_id=abc&project_id=1;DROP');
    expect([empty.status, empty.body]).toEqual([200, []]);
    expect((await call('GET', '/api/projects/recent')).body).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it('최대 20개까지만 조회한다', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => i + 1).join(',');
    await call('GET', `/api/projects/recent?project_id=${ids}`);
    expect(sqlOf('rawMany')!.params.filter((p) => typeof p === 'number')).toHaveLength(40);
  });

  it('응답은 기존 camelCase 키를 유지하고 숫자로 내려준다', async () => {
    answers.rawMany = [{ project_id: 1, imageUrl: 'u', title: 't', shortDescription: 's', goalAmount: '10', currentAmount: '5', achievement: '50', remainingDay: '2' }];
    const res = await call('GET', '/api/projects/recent?project_id=1');
    expect(res.body[0]).toEqual({ project_id: 1, imageUrl: 'u', title: 't', shortDescription: 's', goalAmount: 10, currentAmount: 5, achievement: 50, remainingDay: 2 });
  });
});

// --- L1 후기 ------------------------------------------------------------------------
describe('L1: 후기 목록', () => {
  it('SQL에서 LIMIT/OFFSET으로 자르고 전체 개수를 따로 센다', async () => {
    answers.count = 25;
    answers.rawMany = [{ project_id: 1, image_url: 'u', title: 't', content: 'c' }];
    const res = await call('GET', '/profiles/my-comments?page=2&limit=10', { user: 1 });
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ totalItems: 25, totalPages: 3, currentPage: 2, limit: 10 });
    const { sql } = sqlOf('rawMany')!;
    expect(sql).toMatch(/ORDER BY comment.created_at DESC, comment.comment_id DESC LIMIT 10 OFFSET 10$/);
  });

  it('page가 음수여도 엉뚱한 구간이 아니라 기본값, limit은 상한 50, 후기가 없으면 조회하지 않는다', async () => {
    answers.count = 5;
    await call('GET', '/profiles/my-comments?page=-3&limit=9999', { user: 1 });
    expect(sqlOf('rawMany')!.sql).toMatch(/LIMIT 50 OFFSET 0$/);

    captured.length = 0;
    answers.count = 0;
    const empty = await call('GET', '/profiles/my-comments', { user: 1 });
    expect(empty.body).toEqual({ meta: { totalItems: 0, totalPages: 0, currentPage: 1, limit: 10 }, data: [] });
    expect(captured.some((c) => c.kind === 'rawMany')).toBe(false);
  });
});

describe('공개 프로필 목록', () => {
  it('타 회원 ID 검증과 프로젝트 단위 행', async () => {
    expect((await call('GET', '/profiles/abc')).status).toBe(400);
    answers.rawMany = [{ project_id: 1, project_title: 't', achievement: '3', remaining_day: '4', current_amount: '9' }];
    const res = await call('GET', '/profiles/7');
    expect(res.body[0]).toMatchObject({ project_title: 't', achievement: 3, remaining_day: 4, current_amount: 9 });
    expect(sqlOf('rawMany')!.params).toContain(7);
  });
});

describe('L: 설정', () => {
  it('data-source는 logging: true 를 쓰지 않는다', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../data-source.ts'), 'utf8');
    expect(src).not.toMatch(/logging:\s*true/);
  });
});
