import http, { Server } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';

/**
 * 실제 라우터/컨트롤러/전역 에러 핸들러를 express로 띄운다.
 * DB는 메모리 위의 가짜 저장소, funding-service는 요청을 기록하는 가짜 HTTP 서버로 대신한다.
 * SUM/COUNT 같은 집계 쿼리는 실행하지 않고, 쿼리 빌더가 만든 SQL과 파라미터를 검사한다.
 */

jest.mock('@shared/entities', () => ({
  PaymentHistory: class PaymentHistory {},
  PaymentInfo: class PaymentInfo {},
  PaymentSchedule: class PaymentSchedule {},
  OptionData: class OptionData {},
  Project: class Project {},
  paymentEntities: [],
}));

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const tables: Record<string, Row[]> = {};
let nextId = 1000;
const calls: { kind: string; sql?: string; params?: unknown }[] = [];
const answers: { rawOne?: (c: { sql: string; params: Row }) => unknown; query?: (sql: string, params: unknown[]) => unknown; count?: number } = {};

const TODAY = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const shift = (days: number) => new Date(Date.now() + (9 * 3600 + days * 86400) * 1000).toISOString().slice(0, 10);

const reset = () => {
  for (const n of ['PaymentInfo', 'PaymentSchedule', 'PaymentHistory', 'OptionData', 'Project']) tables[n] = [];
  // 사용자 1(나), 2(다른 사람)
  tables.PaymentInfo.push(
    { id: 10, userId: 1, method: 'CARD', code: 'KB', displayInfo: '****1234', details: { type: 'card', expMonth: '12', expYear: '29', token: 'SECRET', cvc: '999' }, isActive: true, isPrimary: false, createdAt: new Date() },
    { id: 20, userId: 2, method: 'CARD', code: 'KB', displayInfo: '****9999', details: { type: 'card', expMonth: '01', expYear: '30' }, isActive: true, isPrimary: false, createdAt: new Date() }
  );
  tables.Project.push(
    { projectId: 100, title: '진행 중', imageUrl: 'img-100', startDate: shift(-5), endDate: shift(20), user: { userId: 9 } },
    { projectId: 101, title: '다른 프로젝트', imageUrl: 'img-101', startDate: shift(-5), endDate: shift(20), user: { userId: 9 } },
    { projectId: 102, title: '종료됨', imageUrl: 'img-102', startDate: shift(-30), endDate: shift(-2), user: { userId: 9 } },
    { projectId: 103, title: '시작 전', imageUrl: 'img-103', startDate: shift(3), endDate: shift(30), user: { userId: 9 } },
    { projectId: 104, title: '내 프로젝트', imageUrl: 'img-104', startDate: shift(-5), endDate: shift(20), user: { userId: 1 } }
  );
  tables.OptionData.push(
    { optionId: 7, title: '비싼 옵션', price: 50000, project: { projectId: 100 } },
    { optionId: 8, title: '싼 옵션', price: 0, project: { projectId: 100 } },
    { optionId: 9, title: '남의 프로젝트 옵션', price: 1000, project: { projectId: 101 } }
  );
  calls.length = 0;
  answers.rawOne = undefined;
  answers.query = undefined;
  answers.count = undefined;
  nextId = 1000;
};

const matchValue = (actual: unknown, expected: any): boolean => { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (expected && typeof expected === 'object') return actual !== null && typeof actual === 'object' && matches(actual as Row, expected);
  return actual === expected;
};
const matches = (row: Row, where: Row): boolean => Object.entries(where).every(([k, v]) => v !== undefined && matchValue(row[k], v));

const repoFor = (name: string) => {
  const findRel = (row: Row): Row => {
    if (name !== 'PaymentSchedule') return row;
    // 관계를 채워서 돌려준다. (삭제된 결제 수단/프로젝트는 null)
    return {
      ...row,
      paymentInfo: row.paymentInfoId ? tables.PaymentInfo.find((p) => p.id === row.paymentInfoId) ?? null : null,
      project: row.projectId ? tables.Project.find((p) => p.projectId === row.projectId) ?? null : null,
      option: row.optionId ? tables.OptionData.find((o) => o.optionId === row.optionId) ?? null : null,
    };
  };
  const whereOf = (where: Row) => (name === 'PaymentSchedule' ? Object.fromEntries(Object.entries(where).map(([k, v]) => (k === 'project' ? ['projectId', (v as Row).projectId] : [k, v]))) : where);
  const rows = () => tables[name].map(findRel);
  return {
    create: (data: Row) => {
      const entity = { ...data };
      Object.defineProperty(entity, '__entity', { value: name, enumerable: false });
      return entity;
    },
    save: async (data: Row) => {
      const entity = { ...data };
      if (name === 'PaymentSchedule') {
        entity.paymentInfoId = data.paymentInfo?.id ?? data.paymentInfoId;
        entity.projectId = data.project?.projectId ?? data.projectId;
        entity.optionId = data.option === null ? undefined : data.option?.optionId ?? data.optionId;
      }
      if (entity.id === undefined) {
        entity.id = nextId++;
        tables[name].push(entity);
      } else {
        const idx = tables[name].findIndex((r) => r.id === entity.id);
        if (idx >= 0) Object.assign(tables[name][idx], entity);
        else tables[name].push(entity);
      }
      return entity;
    },
    findOne: async ({ where }: { where: Row }) => rows().find((r) => matches(r, whereOf(where))) ?? null,
    findOneBy: async (where: Row) => rows().find((r) => matches(r, whereOf(where))) ?? null,
    exists: async ({ where }: { where: Row }) => rows().some((r) => matches(r, whereOf(where))),
    find: async ({ where }: { where: Row }) => rows().filter((r) => matches(r, whereOf(where))),
    findAndCount: async ({ where }: { where: Row }) => {
      const list = rows().filter((r) => matches(r, whereOf(where)));
      return [list, list.length];
    },
    count: async () => answers.count ?? 0,
    update: async (criteria: Row, values: Row) => {
      calls.push({ kind: `update:${name}`, params: { criteria, values } });
      for (const r of tables[name].filter((row) => matches(row, criteria))) Object.assign(r, values);
    },
    delete: async (criteria: Row) => {
      calls.push({ kind: `delete:${name}`, params: criteria });
      tables[name] = tables[name].filter((r) => !matches(r, criteria));
    },
    remove: async (entity: Row) => {
      tables[name] = tables[name].filter((r) => r.id !== entity.id);
    },
    createQueryBuilder: () => {
      const parts: string[] = [];
      const params: Row = {};
      const qb: Record<string, unknown> = {};
      for (const m of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy']) {
        qb[m] = (sql: string, p?: Row | string) => {
          parts.push(`${m === 'select' || m === 'addSelect' ? 'SEL ' : ''}${typeof p === 'string' ? `${sql} AS ${p}` : sql}`);
          if (p && typeof p === 'object') Object.assign(params, p);
          return qb;
        };
      }
      const finish = (kind: string) => async () => {
        const c = { kind, sql: parts.join(' | '), params };
        calls.push(c);
        return kind === 'rawOne' ? answers.rawOne?.(c) : [];
      };
      qb.getRawOne = finish('rawOne');
      qb.getRawMany = finish('rawMany');
      return qb;
    },
  };
};

const managerOf = () => ({
  getRepository: (entity: { name: string }) => repoFor(entity.name),
  findOne: (entity: { name: string }, opts: { where: Row }) => repoFor(entity.name).findOne(opts),
  findOneBy: (entity: { name: string }, where: Row) => repoFor(entity.name).findOneBy(where),
  exists: (entity: { name: string }, opts: { where: Row }) => repoFor(entity.name).exists(opts),
  create: (entity: { name: string }, data: Row) => repoFor(entity.name).create(data),
  update: (entity: { name: string }, criteria: Row, values: Row) => repoFor(entity.name).update(criteria, values),
  remove: (entity: Row) => repoFor('PaymentSchedule').remove(entity),
  save: async (a: any, b?: Row) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (typeof a === 'function') return repoFor(a.name).save(b as Row);
    const name = (a as { __entity?: string }).__entity ?? 'PaymentSchedule';
    return repoFor(name).save(a);
  },
});

let transactionFails = false;
jest.mock('../data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => repoFor(entity.name),
    query: async (sql: string, params: unknown[]) => {
      calls.push({ kind: 'query', sql: sql.replace(/\s+/g, ' ').trim(), params });
      const custom = answers.query?.(sql, params);
      if (custom !== undefined) return custom;
      if (sql.includes('payment_schedule WHERE payment_info_id')) {
        return [{ used: tables.PaymentSchedule.filter((s) => s.paymentInfoId === params[0]).length }];
      }
      return [{ total: 0 }];
    },
    transaction: async (cb: (m: ReturnType<typeof managerOf>) => Promise<unknown>) => {
      // 실제 트랜잭션처럼 실패하면 변경을 되돌린다.
      const snapshot = JSON.stringify(tables);
      try {
        return await cb(managerOf());
      } catch (err) {
        const restored = JSON.parse(snapshot);
        for (const k of Object.keys(tables)) tables[k] = restored[k].map((r: Row) => ({ ...r, ...(r.scheduleDate ? { scheduleDate: new Date(r.scheduleDate) } : {}) }));
        throw err;
      } finally {
        transactionFails = false;
      }
    },
  },
}));

// --- 서버 --------------------------------------------------------------------
let server: Server;
let fundingServer: Server;
let base: string;
const fundingReceived: http.IncomingHttpHeaders[] = [];

const listen = (srv: Server) =>
  new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port)));

beforeAll(async () => {
  process.env.LOG_LEVEL = 'silent';
  jest.spyOn(console, 'error').mockImplementation(() => undefined);

  fundingServer = http.createServer((req, res) => {
    fundingReceived.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([{ project_id: 100 }, { project_id: 104 }]));
  });
  process.env.FUNDING_SERVICE_PORT = String(await listen(fundingServer));

  const { headerToLocals, errorHandler, requireUser } = await import('@shared/config');
  const app = express();
  app.use(express.json({ limit: '20kb' }));
  app.use(headerToLocals);
  app.use(['/payments', '/reservations', '/statistics'], requireUser);
  app.use('/payments', (await import('../routes/payment-route')).default);
  app.use('/reservations', (await import('../routes/reservation-route')).default);
  app.use('/statistics', (await import('../routes/statistics-route')).default);
  app.use(errorHandler);
  server = http.createServer(app);
  base = `http://127.0.0.1:${await listen(server)}`;
});

afterAll(async () => {
  for (const s of [server, fundingServer]) await new Promise((resolve) => s.close(resolve));
});

beforeEach(() => {
  reset();
  fundingReceived.length = 0;
  void transactionFails;
});

const call = async (method: string, path: string, opts: { user?: number; body?: unknown; raw?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.user) headers['x-user-id'] = String(opts.user);
  const res = await fetch(base + path, { method, headers, body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)) });
  const text = await res.text();
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { status: res.status, body, text };
};

const validReservation = (over: Row = {}) => ({
  paymentInfoId: 10,
  projectId: 100,
  rewardId: 7,
  amount: 1000,
  rewardAmount: 50000,
  donateAmount: 500,
  totalAmount: 51500,
  scheduleDate: '2000-01-01',
  ...over,
});

const savedSchedule = () => tables.PaymentSchedule[0];

// --- L1 인증 ----------------------------------------------------------------------
describe('L1: 비로그인 요청', () => {
  it.each([
    ['GET', '/payments'], ['POST', '/payments'], ['GET', '/payments/10'], ['DELETE', '/payments/10'],
    ['GET', '/reservations'], ['POST', '/reservations'], ['GET', '/reservations/1'], ['PATCH', '/reservations/1'],
    ['PUT', '/reservations/1/payment_info'], ['DELETE', '/reservations/1'],
    ['GET', '/statistics/count'], ['GET', '/statistics/summary'], ['GET', '/statistics/history'], ['GET', '/statistics/graph'],
  ])('%s %s → 401이고 서비스는 살아 있다', async (method, path) => {
    expect((await call(method, path, { body: method === 'GET' ? undefined : {} })).status).toBe(401);
    expect((await call('GET', '/payments', { user: 1 })).status).toBe(200);
  });
});

// --- H1 금액 ----------------------------------------------------------------------
describe('H1: 금액은 서버가 계산한다', () => {
  it('정상 요청: 옵션 가격은 DB에서 조회하고 총액을 서버가 계산해 저장한다', async () => {
    const res = await call('POST', '/reservations', { user: 1, body: validReservation() });
    expect(res.status).toBe(201);
    expect(savedSchedule()).toMatchObject({ amount: 1000, donateAmount: 500, totalAmount: 51500, userId: 1 });
  });

  it('리워드 금액을 0으로 속여 총액을 줄이면 거부한다', async () => {
    const res = await call('POST', '/reservations', { user: 1, body: validReservation({ rewardAmount: 0, totalAmount: 1500 }) });
    expect(res.status).toBe(400);
    expect(tables.PaymentSchedule).toHaveLength(0);
  });

  it('rewardAmount/totalAmount를 보내지 않아도 서버 계산값으로 저장된다', async () => {
    const body = validReservation();
    delete (body as Row).rewardAmount;
    delete (body as Row).totalAmount;
    expect((await call('POST', '/reservations', { user: 1, body })).status).toBe(201);
    expect(savedSchedule().totalAmount).toBe(51500);
  });

  it('클라이언트 totalAmount가 서버 계산값과 다르면 거부한다', async () => {
    const res = await call('POST', '/reservations', { user: 1, body: validReservation({ totalAmount: 1500 }) });
    expect(res.status).toBe(400);
  });

  it.each([
    ['음수 amount', { amount: -49000, totalAmount: 1500 }],
    ['음수 donateAmount', { donateAmount: -50000, totalAmount: 1000 }],
    ['문자열 amount', { amount: '1000' }],
    ['문자열 donateAmount', { donateAmount: '500' }],
    ['소수 amount', { amount: 10.5 }],
    ['NaN처럼 보이는 값', { amount: null, totalAmount: 50500 - 500 }],
    ['int 초과', { amount: 3_000_000_000 }],
    ['객체', { amount: {} }],
  ])('%s → 400', async (_name, over) => {
    const res = await call('POST', '/reservations', { user: 1, body: validReservation(over) });
    expect(res.status).toBe(400);
    expect(tables.PaymentSchedule).toHaveLength(0);
  });

  it('옵션이 없고 금액도 0이면 거부한다', async () => {
    const res = await call('POST', '/reservations', { user: 1, body: { paymentInfoId: 10, projectId: 100, amount: 0 } });
    expect(res.status).toBe(400);
  });

  it('PATCH: 리워드만 바꿔도 총액이 다시 계산된다(싼 옵션 → 비싼 옵션)', async () => {
    await call('POST', '/reservations', { user: 1, body: validReservation({ rewardId: 8, rewardAmount: 0, totalAmount: 1500 }) });
    expect(savedSchedule().totalAmount).toBe(1500);

    tables.PaymentSchedule[0].scheduleDate = new Date(Date.now() + 10 * 86400000);
    const res = await call('PATCH', `/reservations/${savedSchedule().id}`, { user: 1, body: { rewardId: 7 } });
    expect(res.status).toBe(200);
    expect(savedSchedule().totalAmount).toBe(1000 + 50000 + 500);
  });

  it('PATCH: rewardId를 null로 보내면 리워드가 제거되고(첫 번째 옵션으로 바뀌지 않음) 총액이 줄어든다', async () => {
    await call('POST', '/reservations', { user: 1, body: validReservation() });
    tables.PaymentSchedule[0].scheduleDate = new Date(Date.now() + 10 * 86400000);
    const res = await call('PATCH', `/reservations/${savedSchedule().id}`, { user: 1, body: { rewardId: null } });
    expect(res.status).toBe(200);
    expect(savedSchedule().optionId).toBeUndefined();
    expect(savedSchedule().totalAmount).toBe(1500);
  });

  it('PATCH: 다른 프로젝트의 옵션이나 문자열 후원금은 거부한다', async () => {
    await call('POST', '/reservations', { user: 1, body: validReservation() });
    tables.PaymentSchedule[0].scheduleDate = new Date(Date.now() + 10 * 86400000);
    const id = savedSchedule().id;
    expect((await call('PATCH', `/reservations/${id}`, { user: 1, body: { rewardId: 9 } })).status).toBe(400);
    expect((await call('PATCH', `/reservations/${id}`, { user: 1, body: { donateAmount: '500' } })).status).toBe(400);
    expect((await call('PATCH', `/reservations/${id}`, { user: 1, body: { donateAmount: -1 } })).status).toBe(400);
    expect(savedSchedule().totalAmount).toBe(51500);
  });

  it('PATCH: scheduleDate를 보내도 결제일은 바뀌지 않는다', async () => {
    await call('POST', '/reservations', { user: 1, body: validReservation() });
    const before = savedSchedule().scheduleDate;
    savedSchedule().scheduleDate = new Date(Date.now() + 10 * 86400000);
    const fixed = savedSchedule().scheduleDate;
    await call('PATCH', `/reservations/${savedSchedule().id}`, { user: 1, body: { scheduleDate: '2000-01-01', address: '서울' } });
    expect(savedSchedule().scheduleDate).toBe(fixed);
    expect(savedSchedule().address).toBe('서울');
    expect(before).toBeInstanceOf(Date);
  });
});

// --- H2 소유권 --------------------------------------------------------------------
describe('H2: 결제 수단 소유권', () => {
  it('다른 사용자의 결제 수단으로는 예약할 수 없다', async () => {
    const res = await call('POST', '/reservations', { user: 1, body: validReservation({ paymentInfoId: 20 }) });
    expect(res.status).toBe(400);
    expect(tables.PaymentSchedule).toHaveLength(0);
  });

  it('비활성화된 결제 수단으로는 예약할 수 없다', async () => {
    tables.PaymentInfo[0].isActive = false;
    expect((await call('POST', '/reservations', { user: 1, body: validReservation() })).status).toBe(400);
  });

  it('예약에 연결된 남의 결제 수단은 덮어쓸 수 없다', async () => {
    // 과거 데이터/다른 경로로 내 예약에 남의 결제 수단(20)이 연결된 상태를 가정
    tables.PaymentSchedule.push({ id: 500, userId: 1, paymentInfoId: 20, projectId: 100, amount: 1, totalAmount: 1, executed: false, scheduleDate: new Date(Date.now() + 10 * 86400000) });
    const res = await call('PUT', '/reservations/500/payment_info', {
      user: 1,
      body: { method: 'CARD', code: 'KB', displayInfo: '****0000', details: { type: 'card', expMonth: '01', expYear: '30' } },
    });
    expect(res.status).toBe(404);
    expect(calls.some((c) => c.kind === 'update:PaymentInfo')).toBe(false);
    expect(tables.PaymentInfo[1].displayInfo).toBe('****9999');
  });

  it('내 결제 수단은 {id, userId} 조건으로 검증된 값만 수정된다', async () => {
    tables.PaymentSchedule.push({ id: 501, userId: 1, paymentInfoId: 10, projectId: 100, amount: 1, totalAmount: 1, executed: false, scheduleDate: new Date(Date.now() + 10 * 86400000) });
    const res = await call('PUT', '/reservations/501/payment_info', {
      user: 1,
      body: { method: 'CARD', code: 'NH', displayInfo: '****4321', details: { type: 'card', expMonth: '11', expYear: '2030' }, token: 'ignored' },
    });
    expect(res.status).toBe(200);
    const update = calls.find((c) => c.kind === 'update:PaymentInfo')!.params as Row;
    expect(update.criteria).toEqual({ id: 10, userId: 1 });
    expect(update.values).toEqual({ method: 'CARD', code: 'NH', displayInfo: '****4321', details: { type: 'card', expMonth: '11', expYear: '2030' } });
    expect(JSON.stringify(update.values)).not.toContain('ignored');
  });

  it('결제 예정일 하루 전부터는 수정할 수 없고 이유를 알려준다', async () => {
    tables.PaymentSchedule.push({ id: 502, userId: 1, paymentInfoId: 10, projectId: 100, amount: 1, totalAmount: 1, executed: false, scheduleDate: new Date(Date.now() + 3600 * 1000) });
    const res = await call('PUT', '/reservations/502/payment_info', {
      user: 1,
      body: { method: 'CARD', code: 'KB', displayInfo: '****1', details: { type: 'card', expMonth: '1', expYear: '30' } },
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('결제 예정일 하루 전부터는');
  });
});

// --- M1 삭제/취소 --------------------------------------------------------------------
describe('M1: 삭제와 취소', () => {
  it('사용 중이 아닌 결제 수단은 삭제가 끝난 뒤 200을 준다(await)', async () => {
    const res = await call('DELETE', '/payments/10', { user: 1 });
    expect(res.status).toBe(200);
    expect(tables.PaymentInfo.some((p) => p.id === 10)).toBe(false);
  });

  it('예약에 연결된 결제 수단은 지우지 않고 비활성화한다(예약 조회/취소가 깨지지 않음)', async () => {
    tables.PaymentSchedule.push({ id: 600, userId: 1, paymentInfoId: 10, projectId: 100, amount: 1, totalAmount: 1, executed: false, scheduleDate: new Date(Date.now() + 10 * 86400000), createdAt: new Date() });
    expect((await call('DELETE', '/payments/10', { user: 1 })).status).toBe(200);
    expect(tables.PaymentInfo.find((p) => p.id === 10)?.isActive).toBe(false);
    // 목록에서는 사라진다
    const list = await call('GET', '/payments', { user: 1 });
    expect(list.body.data).toEqual([]);
    // 예약은 여전히 조회/취소 가능
    expect((await call('GET', '/reservations/600', { user: 1 })).status).toBe(200);
    expect((await call('DELETE', '/reservations/600', { user: 1 })).status).toBe(200);
  });

  it('남의 결제 수단 삭제는 404이고 아무것도 지우지 않는다', async () => {
    expect((await call('DELETE', '/payments/20', { user: 1 })).status).toBe(404);
    expect(tables.PaymentInfo).toHaveLength(2);
  });

  it('결제 수단이 삭제된(null) 예약과 프로젝트가 삭제된(null) 예약도 조회·취소된다', async () => {
    tables.PaymentSchedule.push(
      { id: 610, userId: 1, paymentInfoId: undefined, projectId: 100, amount: 1, totalAmount: 1, executed: false, scheduleDate: new Date(Date.now() + 10 * 86400000), createdAt: new Date() },
      { id: 611, userId: 1, paymentInfoId: 10, projectId: undefined, amount: 2, totalAmount: 2, executed: false, scheduleDate: new Date(Date.now() + 10 * 86400000), createdAt: new Date() }
    );
    const list = await call('GET', '/reservations', { user: 1 });
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(2);
    expect(list.body.data.find((d: Row) => d.scheduleId === 611)).toMatchObject({ productName: null, productImage: null });

    expect((await call('GET', '/reservations/610', { user: 1 })).body.paymentInfoId).toBeNull();
    expect((await call('GET', '/reservations/611', { user: 1 })).body.productName).toBeNull();
    expect((await call('DELETE', '/reservations/610', { user: 1 })).status).toBe(200);
    expect((await call('DELETE', '/reservations/611', { user: 1 })).status).toBe(200);
    expect(tables.PaymentHistory).toHaveLength(2);
    expect(tables.PaymentHistory.map((h) => h.status)).toEqual(['cancel', 'cancel']);
  });

  it('취소하면 이력에 스냅샷이 남고 예약은 사라진다', async () => {
    await call('POST', '/reservations', { user: 1, body: validReservation() });
    const id = savedSchedule().id;
    expect((await call('DELETE', `/reservations/${id}`, { user: 1 })).status).toBe(200);
    expect(tables.PaymentSchedule).toHaveLength(0);
    expect(tables.PaymentHistory[0]).toMatchObject({ scheduleId: id, projectTitle: '진행 중', totalAmount: 51500, status: 'cancel' });
  });

  it('이미 실행된 예약, 종료된 프로젝트의 예약은 취소할 수 없다(409)', async () => {
    tables.PaymentSchedule.push(
      { id: 620, userId: 1, paymentInfoId: 10, projectId: 100, amount: 1, totalAmount: 1, executed: true, scheduleDate: new Date(), createdAt: new Date() },
      { id: 621, userId: 1, paymentInfoId: 10, projectId: 102, amount: 1, totalAmount: 1, executed: false, scheduleDate: new Date(), createdAt: new Date() }
    );
    expect((await call('DELETE', '/reservations/620', { user: 1 })).status).toBe(409);
    expect((await call('DELETE', '/reservations/621', { user: 1 })).status).toBe(409);
    expect(tables.PaymentSchedule).toHaveLength(2);
  });

  it('예약이 없으면 404가 아니라 200 빈 목록', async () => {
    const res = await call('GET', '/reservations', { user: 1 });
    expect([res.status, res.body]).toEqual([200, { data: [], count: 0 }]);
  });

  it('잘못된 ID는 500이 아니라 400', async () => {
    for (const id of ['abc', '0', '-1', '1.5']) {
      expect((await call('GET', `/reservations/${id}`, { user: 1 })).status).toBe(400);
      expect((await call('DELETE', `/payments/${id}`, { user: 1 })).status).toBe(400);
    }
  });
});

// --- M2 예약 규칙 -----------------------------------------------------------------------
describe('M2: 예약 규칙', () => {
  it('진행 중인 프로젝트만 후원할 수 있다(종료/시작 전 거부)', async () => {
    expect((await call('POST', '/reservations', { user: 1, body: validReservation({ projectId: 102, rewardId: undefined, rewardAmount: undefined, totalAmount: 1500 }) })).status).toBe(400);
    expect((await call('POST', '/reservations', { user: 1, body: validReservation({ projectId: 103, rewardId: undefined, rewardAmount: undefined, totalAmount: 1500 }) })).status).toBe(400);
    expect((await call('POST', '/reservations', { user: 1, body: validReservation({ projectId: 999 }) })).status).toBe(400);
  });

  it('자기 프로젝트에는 후원할 수 없다', async () => {
    const res = await call('POST', '/reservations', { user: 1, body: validReservation({ projectId: 104, rewardId: undefined, rewardAmount: undefined, totalAmount: 1500 }) });
    expect(res.status).toBe(403);
  });

  it('다른 프로젝트의 옵션은 쓸 수 없다', async () => {
    expect((await call('POST', '/reservations', { user: 1, body: validReservation({ rewardId: 9, rewardAmount: 1000, totalAmount: 2500 }) })).status).toBe(400);
  });

  it('같은 프로젝트에 중복 예약(더블 클릭)은 409', async () => {
    expect((await call('POST', '/reservations', { user: 1, body: validReservation() })).status).toBe(201);
    expect((await call('POST', '/reservations', { user: 1, body: validReservation() })).status).toBe(409);
    expect(tables.PaymentSchedule).toHaveLength(1);
  });

  it('결제일은 클라이언트가 아니라 서버가 정한다(종료일 다음 날 한국 시간 0시)', async () => {
    await call('POST', '/reservations', { user: 1, body: validReservation({ scheduleDate: '2000-01-01' }) });
    const expected = new Date(`${shift(21)}T00:00:00+09:00`).getTime();
    expect(savedSchedule().scheduleDate.getTime()).toBe(expected);
  });

  it('배송지 검증: 길이와 우편번호 형식', async () => {
    expect((await call('POST', '/reservations', { user: 1, body: validReservation({ address: 'a'.repeat(256) }) })).status).toBe(400);
    expect((await call('POST', '/reservations', { user: 1, body: validReservation({ addressNumber: 'abc' }) })).status).toBe(400);
    expect((await call('POST', '/reservations', { user: 1, body: validReservation({ addressNumber: '06236', address: '서울' }) })).status).toBe(201);
    expect(savedSchedule()).toMatchObject({ addressNumber: 6236, address: '서울' });
  });
});

// --- M3 통계 ----------------------------------------------------------------------------
describe('M3: 통계', () => {
  const summaryQb = () => calls.filter((c) => c.kind === 'rawOne');

  it('기간 파라미터는 startDate/endDate이고 형식이 틀리면 400(빈 결과로 넘어가지 않음)', async () => {
    for (const q of ['startDate=abc&endDate=2026-01-01', 'startDate=2026-01-01', 'endDate=2026-01-01', 'startDate=2026-02-30&endDate=2026-03-01', 'startDate=2026-02-01&endDate=2026-01-01', 'startDate[]=1&endDate=2026-01-01']) {
      expect((await call('GET', `/statistics/summary?${q}`, { user: 1 })).status).toBe(400);
    }
  });

  it('기간 없음: 합계는 SQL SUM/COUNT로 계산하고 키는 totalCount', async () => {
    answers.rawOne = (c) => (c.sql.includes('payment_schedule') || c.sql.includes('s.total_amount') ? { count: '2', amount: '3000' } : { count: '1', amount: '500' });
    const res = await call('GET', '/statistics/summary', { user: 1 });
    expect(res.body).toEqual({ totalAmount: 3500, totalCount: 3, reservedAmount: 3000, paidAmount: 500 });
    const sql = summaryQb().map((c) => c.sql).join(' ');
    expect(sql).toContain('SEL COUNT(*) AS count');
    expect(sql).toContain('SEL COALESCE(SUM(s.total_amount), 0) AS amount');
    expect(sql).toContain('SEL COALESCE(SUM(h.total_amount), 0) AS amount');
  });

  it('기간 있음: 종료일 당일을 포함하고(다음 날 0시 미만) 한국 시간 기준, 두 가지 count 키를 모두 준다', async () => {
    answers.rawOne = () => ({ count: '1', amount: '100' });
    const res = await call('GET', '/statistics/summary?startDate=2026-03-01&endDate=2026-03-31', { user: 1 });
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(2);
    expect(res.body.totalcount).toBe(2);
    expect(res.body.period).toEqual({ startDay: '2026-03-01', endDay: '2026-03-31', amount: 200, sponsorCount: 1, checkOut: 1 });

    const periodCall = summaryQb().find((c) => (c.params as Row).from)!;
    expect((periodCall.params as Row).from.toISOString()).toBe('2026-02-28T15:00:00.000Z'); // 3/1 00:00 KST
    expect((periodCall.params as Row).to.toISOString()).toBe('2026-03-31T15:00:00.000Z'); // 4/1 00:00 KST (미포함)
    expect(periodCall.sql).toContain('< :to');
  });

  it('history: SQL에서 정렬하고 LIMIT/OFFSET, limit 상한 100, 음수 page는 1', async () => {
    answers.query = (sql) => (sql.includes('AS total') ? [{ total: '25' }] : sql.includes('UNION ALL') ? [{ scheduleId: 1, productImage: 'i', productName: 'n', optionName: null, date: new Date(), amount: '100', status: 'pending' }] : undefined);
    const res = await call('GET', '/statistics/history?page=-3&limit=100000', { user: 1 });
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ totalItems: 25, totalPages: 1, currentPage: 1, limit: 100 });
    expect(res.body.data[0]).toMatchObject({ amount: 100, optionName: null, status: 'pending' });

    const q = calls.find((c) => c.sql?.includes('UNION ALL'))!;
    expect(q.sql).toContain('ORDER BY history.date DESC, history.scheduleId DESC LIMIT ? OFFSET ?');
    expect(q.params).toEqual([1, 1, 100, 0]);

    calls.length = 0;
    await call('GET', '/statistics/history?page=3&limit=10', { user: 1 });
    expect(calls.find((c) => c.sql?.includes('UNION ALL'))!.params).toEqual([1, 1, 10, 20]);
  });

  it('history: 내역이 없으면 목록 쿼리를 실행하지 않는다', async () => {
    const res = await call('GET', '/statistics/history', { user: 1 });
    expect(res.body.data).toEqual([]);
    expect(calls.some((c) => c.sql?.includes('UNION ALL'))).toBe(false);
  });

  it('graph: target 검증, 한국 시간 월 경계, CONVERT_TZ 없음, 후원자 단위 count, 토큰 미전달', async () => {
    expect((await call('GET', '/statistics/graph?target=2026-13', { user: 1 })).status).toBe(400);
    expect((await call('GET', '/statistics/graph?target=abc', { user: 1 })).status).toBe(400);

    const res = await call('GET', '/statistics/graph?target=2026-02', { user: 1 });
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({ year: 2026, month: 2, daysInMonth: 28 });
    expect(res.body.data[0].data).toHaveLength(28);

    const queries = calls.filter((c) => c.kind === 'rawMany');
    expect(queries).toHaveLength(2);
    for (const q of queries) {
      expect(q.sql).not.toContain('CONVERT_TZ');
      expect((q.params as Row).from.toISOString()).toBe('2026-01-31T15:00:00.000Z'); // 2/1 00:00 KST
      expect((q.params as Row).to.toISOString()).toBe('2026-02-28T15:00:00.000Z'); // 3/1 00:00 KST
      expect((q.params as Row).ids).toEqual([100, 104]);
    }
    expect(queries.map((q) => q.sql).join(' ')).toContain('SEL COUNT(DISTINCT s.user_id) AS scheduleCount');
    expect(fundingReceived[0]['x-user-id']).toBe('1');
    expect(fundingReceived[0]['x-access-token']).toBeUndefined();
    expect(fundingReceived[0]['x-refresh-token']).toBeUndefined();
  });

  it('graph: 12월과 윤년 2월도 일수가 맞다', async () => {
    expect((await call('GET', '/statistics/graph?target=2026-12', { user: 1 })).body.meta.daysInMonth).toBe(31);
    expect((await call('GET', '/statistics/graph?target=2028-02', { user: 1 })).body.meta.daysInMonth).toBe(29);
  });
});

// --- M5 결제 정보 -----------------------------------------------------------------------
describe('M5: 결제 정보', () => {
  const card = (over: Row = {}) => ({
    method: 'CARD', code: 'KB', displayInfo: '****1234', details: { type: 'card', expMonth: '12', expYear: '29' }, ...over,
  });

  it('등록: 허용된 필드만 저장되고 token은 필수가 아니며 저장되지 않는다', async () => {
    const res = await call('POST', '/payments', { user: 1, body: { ...card(), token: 'billing-key-123' } });
    expect(res.status).toBe(201);
    const saved = tables.PaymentInfo.find((p) => p.id === res.body.insertedId)!;
    expect(saved).toMatchObject({ userId: 1, method: 'CARD', code: 'KB', displayInfo: '****1234' });
    expect(JSON.stringify(saved)).not.toContain('billing-key-123');
  });

  it.each([
    ['카드 번호가 details에 섞임', { details: { type: 'card', expMonth: '12', expYear: '29', number: '4111111111111111' } }],
    ['CVC가 섞임', { details: { type: 'card', expMonth: '12', expYear: '29', cvc: '123' } }],
    ['카드 번호 전체가 displayInfo', { displayInfo: '4111 1111 1111 1111' }],
    ['카드 번호(하이픈)', { displayInfo: '4111-1111-1111-1111' }],
    ['알 수 없는 type', { details: { type: 'crypto', wallet: 'x' } }],
    ['만료 월 오류', { details: { type: 'card', expMonth: '13', expYear: '29' } }],
    ['details 없음', { details: undefined }],
    ['details 배열', { details: [] }],
    ['잘못된 method', { method: 'CASH' }],
    ['잘못된 은행 코드', { code: 'XX' }],
    ['빈 displayInfo', { displayInfo: '' }],
    ['긴 displayInfo', { displayInfo: 'a'.repeat(256) }],
  ])('%s → 400', async (_name, over) => {
    expect((await call('POST', '/payments', { user: 1, body: card(over) })).status).toBe(400);
    expect(tables.PaymentInfo).toHaveLength(2);
  });

  it('가상계좌 등록은 type, owner만 허용', async () => {
    expect((await call('POST', '/payments', { user: 1, body: card({ method: 'VBANK', details: { type: 'vbank', owner: '홍길동' } }) })).status).toBe(201);
    expect((await call('POST', '/payments', { user: 1, body: card({ method: 'VBANK', details: { type: 'vbank', owner: '홍길동', account: '123' } }) })).status).toBe(400);
  });

  it('조회 응답은 DTO: 토큰/CVC 같은 알 수 없는 상세 값이 나가지 않는다', async () => {
    const list = await call('GET', '/payments', { user: 1 });
    expect(list.status).toBe(200);
    expect(list.body.data[0]).toEqual({
      id: 10, method: 'CARD', code: 'KB', displayInfo: '****1234', details: { type: 'card', expMonth: '12', expYear: '29' },
      isPrimary: false, isActive: true, createdAt: expect.any(String),
    });
    expect(list.text).not.toMatch(/SECRET|999|cvc|token/i);

    const one = await call('GET', '/payments/10', { user: 1 });
    expect(one.text).not.toMatch(/SECRET|cvc|token/i);
    expect((await call('GET', '/payments/20', { user: 1 })).status).toBe(404);
  });
});

describe('L: 설정', () => {
  it('data-source는 logging: true 를 쓰지 않는다', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../data-source.ts'), 'utf8');
    expect(src).not.toMatch(/logging:\s*true/);
  });
});
