import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

/**
 * 실제 라우터/컨트롤러/전역 에러 핸들러를 express로 띄우고, DB는 메모리 위의 가짜 저장소로 대신한다.
 * 비밀번호 해시(pbkdf2)와 JWT는 실제 구현을 그대로 쓴다.
 */

jest.mock('@shared/entities', () => ({
  User: class User {},
  Token: class Token {},
  EmailVerification: class EmailVerification {},
  InterestCategory: class InterestCategory {},
  authEntities: [],
}));

const sentMails: { to: string; code: string }[] = [];
let mailShouldFail = false;
jest.mock('../modules/mailer', () => ({
  sendVerificationMail: async (to: string, code: string) => {
    if (mailShouldFail) throw new Error('smtp down');
    sentMails.push({ to, code });
  },
}));

// --- 메모리 DB -----------------------------------------------------------------
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const tables: Record<string, Row[]> = { User: [], Token: [], EmailVerification: [], InterestCategory: [] };
let ids = { User: 1, Token: 1, EmailVerification: 1, InterestCategory: 1 };
const PK: Record<string, string> = { User: 'userId', Token: 'id', EmailVerification: 'verificationId', InterestCategory: 'interestCategoryId' };
const failNext: { interestCategory?: string } = {};

const matchValue = (actual: unknown, expected: any): boolean => { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (expected && typeof expected === 'object' && 'value' in expected && '_type' in expected) {
    return (expected.value as unknown[]).includes(actual);
  }
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    return actual !== null && typeof actual === 'object' && matches(actual as Row, expected);
  }
  return actual === expected;
};
const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => v !== undefined && matchValue(row[k], v));

const nameOf = (entity: { name: string }) => entity.name;

const repoFor = (name: string) => ({
  // DB 기본값 흉내
  create: (data: Row) => ({ ...(name === 'EmailVerification' ? { isUsed: false } : {}), ...data }),
  save: async (data: Row) => {
    if (name === 'InterestCategory' && failNext.interestCategory) {
      const code = failNext.interestCategory;
      failNext.interestCategory = undefined;
      throw Object.assign(new Error('fk'), { driverError: { code } });
    }
    const pk = PK[name];
    if (name === 'Token' && data.user) data.userId = data.user.userId;
    if (data[pk] === undefined) {
      if (name === 'User' && tables.User.some((u) => u.email === data.email)) {
        throw Object.assign(new Error('dup'), { driverError: { code: 'ER_DUP_ENTRY' } });
      }
      data[pk] = ids[name as keyof typeof ids]++;
      tables[name].push(data);
    } else {
      const idx = tables[name].findIndex((r) => r[pk] === data[pk]);
      tables[name][idx] = Object.assign(tables[name][idx], data);
    }
    return data;
  },
  findOne: async ({ where, select, order }: { where: Row; select?: Row; order?: Row; relations?: unknown }) => {
    let rows = tables[name].filter((r) => matches(r, where));
    if (order) rows = [...rows].sort((a, b) => b[PK[name]] - a[PK[name]]);
    const row = rows[0];
    if (!row) return null;
    const out: Row = { ...row };
    // select:false 컬럼은 명시했을 때만 읽힌다.
    if (name === 'User') {
      for (const hidden of ['password', 'salt']) if (!select?.[hidden]) delete out[hidden];
    }
    if (name === 'Token') out.user = { ...tables.User.find((u) => u.userId === row.userId), password: undefined, salt: undefined };
    return out;
  },
  exists: async ({ where }: { where: Row }) => tables[name].some((r) => matches(r, where)),
  update: async (criteria: Row, values: Row) => {
    for (const r of tables[name].filter((row) => matches(row, criteria))) Object.assign(r, values);
  },
  delete: async (criteria: Row) => {
    tables[name] = tables[name].filter((r) => !matches(r, criteria));
  },
  createQueryBuilder: () => {
    const op: { kind?: 'delete' | 'update'; set?: Row; where?: string; params?: Row } = {};
    const qb = {
      delete: () => ((op.kind = 'delete'), qb),
      update: () => ((op.kind = 'update'), qb),
      set: (v: Row) => ((op.set = v), qb),
      where: (sql: string, params: Row) => ((op.where = sql), (op.params = params), qb),
      execute: async () => {
        const p = op.params as Row;
        const hit = (r: Row) => {
          if (r.userId !== p.userId) return false;
          if (op.where!.includes('expires_at <')) return r.expiresAt < p.now;
          if (op.where!.includes('refresh_token IN')) return (p.keys as string[]).includes(r.refreshToken) && r.revoke === false;
          return true;
        };
        if (op.kind === 'delete') tables[name] = tables[name].filter((r) => !hit(r));
        else for (const r of tables[name].filter(hit)) Object.assign(r, op.set);
      },
    };
    return qb;
  },
});

jest.mock('../data-source', () => {
  const manager = {
    exists: async (entity: { name: string }, opts: Row) => repoFor(nameOf(entity)).exists(opts),
    create: (entity: { name: string }, data: Row) => repoFor(nameOf(entity)).create(data),
    save: async (a: any, b?: Row) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (typeof a === 'function') return repoFor(nameOf(a)).save(b as Row);
      return repoFor('User').save(a);
    },
  };
  return {
    AppDataSource: {
      getRepository: (entity: { name: string }) => repoFor(nameOf(entity)),
      // 실제 트랜잭션처럼 실패하면 트랜잭션 안의 변경을 되돌린다.
      transaction: async (cb: (m: typeof manager) => Promise<void>) => {
        const snapshot = JSON.stringify(tables);
        const idSnapshot = { ...ids };
        try {
          await cb(manager);
        } catch (err) {
          const restored = JSON.parse(snapshot);
          for (const k of Object.keys(tables)) tables[k] = restored[k];
          ids = idSnapshot;
          throw err;
        }
      },
    },
  };
});

// --- 서버 --------------------------------------------------------------------
let server: Server;
let base: string;

beforeAll(async () => {
  process.env.PRIVATE_KEY = 'access-secret';
  process.env.REFRESH_TOKEN_SECRET = 'refresh-secret';
  const { headerToLocals, errorHandler } = await import('@shared/config');
  const authRouter = (await import('../routes/auth')).default;
  const oauthRouter = (await import('../routes/oauth')).default;

  const app = express();
  app.use(express.json({ limit: '10kb' }));
  app.use(headerToLocals);
  app.use(cookieParser());
  app.use('/auth', authRouter);
  app.use('/oauth', oauthRouter);
  app.use(errorHandler);

  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(async () => {
  for (const k of Object.keys(tables)) tables[k] = [];
  ids = { User: 1, Token: 1, EmailVerification: 1, InterestCategory: 1 };
  sentMails.length = 0;
  mailShouldFail = false;
  // 이메일 단위 제한 카운터 초기화
  const limits = await import('../modules/limits');
  for (const c of [limits.codeSendCooldown, limits.codeSendHourly, limits.codeVerifyFailures, limits.loginFailures]) {
    for (const email of ['a@example.com', 'b@example.com', 'victim@example.com', 'new@example.com']) c.reset(email);
  }
});

const call = async (method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}) => {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  return { status: res.status, body, text, headers: res.headers, cookies: res.headers.getSetCookie() };
};

const sendAndVerify = async (email: string) => {
  // 같은 이메일로 여러 번 인증하는 테스트가 있어 발송 제한 카운터를 비운다. (제한 자체는 별도 테스트로 검증)
  const limits = await import('../modules/limits');
  limits.codeSendCooldown.reset(email);
  limits.codeSendHourly.reset(email);
  await call('POST', '/auth/codes/send', { body: { email } });
  const { code } = sentMails[sentMails.length - 1];
  const res = await call('POST', '/auth/codes/verify', { body: { email, code } });
  expect(res.status).toBe(200);
  return code;
};

const signUpUser = async (email = 'a@example.com', password = 'Passw0rd!x') => {
  const code = await sendAndVerify(email);
  const res = await call('POST', '/auth/signup', {
    body: { nickname: 'alice', email, code, password, confirm_password: password, category_id: 1 },
  });
  expect(res.status).toBe(201);
};

const cookieValue = (cookies: string[], name: string) => cookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0].split('=')[1];

// --- H1 ----------------------------------------------------------------------
describe('H1: 비밀번호 재설정', () => {
  it('email/code 없이 요청하면 400이고 누구의 비밀번호도 바뀌지 않는다', async () => {
    await signUpUser('victim@example.com');
    const attacker = 'b@example.com';
    await sendAndVerify(attacker); // 공격자가 자기 이메일 인증만 마친 상태

    const before = JSON.stringify(tables.User);
    for (const body of [
      { new_password: 'Hacked123!', confirm_password: 'Hacked123!' },
      { email: null, code: null, new_password: 'Hacked123!', confirm_password: 'Hacked123!' },
      { email: attacker, new_password: 'Hacked123!', confirm_password: 'Hacked123!' },
      { email: { $ne: '' }, code: { $ne: '' }, new_password: 'Hacked123!', confirm_password: 'Hacked123!' },
    ]) {
      expect((await call('PATCH', '/auth/password', { body })).status).toBe(400);
    }
    expect(JSON.stringify(tables.User)).toBe(before);
  });

  it('인증을 마친 본인 이메일로는 재설정되고 이전 비밀번호는 쓸 수 없다', async () => {
    await signUpUser('a@example.com', 'OldPassw0rd');
    const code = await sendAndVerify('a@example.com');
    const res = await call('PATCH', '/auth/password', {
      body: { email: 'a@example.com', code, new_password: 'NewPassw0rd', confirm_password: 'NewPassw0rd' },
    });
    expect(res.status).toBe(200);
    expect((await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'OldPassw0rd' } })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'NewPassw0rd' } })).status).toBe(200);
  });

  it('성공하면 인증 기록이 소진되어 같은 코드로 다시 쓸 수 없다', async () => {
    await signUpUser('a@example.com');
    const code = await sendAndVerify('a@example.com');
    const body = { email: 'a@example.com', code, new_password: 'NewPassw0rd', confirm_password: 'NewPassw0rd' };
    expect((await call('PATCH', '/auth/password', { body })).status).toBe(200);
    expect((await call('PATCH', '/auth/password', { body })).status).toBe(400);
  });

  it('재설정하면 기존 세션(리프레시 토큰)이 폐기된다', async () => {
    await signUpUser('a@example.com', 'OldPassw0rd');
    const login = await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'OldPassw0rd' } });
    const refresh = cookieValue(login.cookies, 'refreshToken')!;

    const code = await sendAndVerify('a@example.com');
    await call('PATCH', '/auth/password', {
      body: { email: 'a@example.com', code, new_password: 'NewPassw0rd', confirm_password: 'NewPassw0rd' },
    });
    expect((await call('POST', '/auth/token', { headers: { 'x-refresh-token': refresh } })).status).toBe(401);
  });

  it('존재하지 않는 이메일도 같은 응답을 준다(계정 열거 방지)', async () => {
    const code = await sendAndVerify('new@example.com');
    const res = await call('PATCH', '/auth/password', {
      body: { email: 'new@example.com', code, new_password: 'NewPassw0rd', confirm_password: 'NewPassw0rd' },
    });
    expect(res.status).toBe(200);
  });

  it('비밀번호 규칙: 짧거나 확인이 다르면 400', async () => {
    const code = await sendAndVerify('a@example.com');
    const base = { email: 'a@example.com', code };
    expect((await call('PATCH', '/auth/password', { body: { ...base, new_password: 'short', confirm_password: 'short' } })).status).toBe(400);
    expect((await call('PATCH', '/auth/password', { body: { ...base, new_password: 'LongEnough1', confirm_password: 'Different11' } })).status).toBe(400);
  });
});

// --- H2 ----------------------------------------------------------------------
describe('H2: 인증 코드', () => {
  it('6자리 숫자 코드를 메일로 보낸다', async () => {
    await call('POST', '/auth/codes/send', { body: { email: 'a@example.com' } });
    expect(sentMails[0].code).toMatch(/^\d{6}$/);
  });

  it('이메일 형식이 아니면 400, 메일은 보내지 않는다', async () => {
    for (const email of [undefined, null, '', 'nope', { a: 1 }, 'a'.repeat(120) + '@x.com']) {
      expect((await call('POST', '/auth/codes/send', { body: { email } })).status).toBe(400);
    }
    expect(sentMails).toHaveLength(0);
  });

  it('같은 이메일로 1분 안에 다시 요청하면 429', async () => {
    expect((await call('POST', '/auth/codes/send', { body: { email: 'a@example.com' } })).status).toBe(200);
    expect((await call('POST', '/auth/codes/send', { body: { email: 'a@example.com' } })).status).toBe(429);
    expect(sentMails).toHaveLength(1);
  });

  it('틀린 코드를 5번 넣으면 6번째부터 429이고 맞는 코드도 무효화된다', async () => {
    await call('POST', '/auth/codes/send', { body: { email: 'a@example.com' } });
    const right = sentMails[0].code;
    const wrong = right === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i++) {
      expect((await call('POST', '/auth/codes/verify', { body: { email: 'a@example.com', code: wrong } })).status).toBe(400);
    }
    expect((await call('POST', '/auth/codes/verify', { body: { email: 'a@example.com', code: right } })).status).toBe(429);
    // 제한이 풀려도(카운터 초기화) 이미 무효화된 코드는 쓸 수 없다
    const { codeVerifyFailures } = await import('../modules/limits');
    codeVerifyFailures.reset('a@example.com');
    expect((await call('POST', '/auth/codes/verify', { body: { email: 'a@example.com', code: right } })).status).toBe(410);
  });

  it('메일 발송에 실패하면 500이고 그 코드는 쓸 수 없다', async () => {
    mailShouldFail = true;
    expect((await call('POST', '/auth/codes/send', { body: { email: 'a@example.com' } })).status).toBe(500);
    const [record] = tables.EmailVerification;
    expect(record.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('인증에 성공하면 가입/재설정을 마칠 시간이 30분으로 늘어난다', async () => {
    await sendAndVerify('a@example.com');
    const [record] = tables.EmailVerification;
    expect(record.isUsed).toBe(true);
    expect(record.expiresAt.getTime() - Date.now()).toBeGreaterThan(25 * 60 * 1000);
  });
});

// --- H3 / 로그 ------------------------------------------------------------------
describe('H3: 쿼리 로그', () => {
  it('data-source 설정에서 logging: true 를 쓰지 않는다', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../data-source.ts'), 'utf8');
    expect(src).not.toMatch(/logging:\s*true/);
    expect(src).toContain("['error', 'warn']");
  });
});

// --- M1/M5 토큰 ------------------------------------------------------------------
describe('M1/M5: 토큰', () => {
  it('리프레시 토큰은 payload에 email이 없어 긴 이메일에도 255자를 넘지 않는다', async () => {
    const longEmail = `${'a'.repeat(88)}@example.com`; // 100자
    await signUpUser(longEmail);
    const login = await call('POST', '/auth/login', { body: { email: longEmail, password: 'Passw0rd!x' } });
    expect(login.status).toBe(200);
    const refresh = cookieValue(login.cookies, 'refreshToken')!;
    expect(refresh.length).toBeLessThan(255);
    expect(jwt.decode(refresh)).not.toHaveProperty('email');
  });

  it('DB에는 리프레시 토큰 원문이 아니라 SHA-256 해시가 저장된다', async () => {
    await signUpUser();
    const login = await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'Passw0rd!x' } });
    const refresh = cookieValue(login.cookies, 'refreshToken')!;
    const [row] = tables.Token;
    expect(row.refreshToken).toBe(crypto.createHash('sha256').update(refresh).digest('hex'));
    expect(row.refreshToken).not.toBe(refresh);
  });

  it('갱신: 유효한 토큰이면 email이 담긴 새 액세스 토큰을 쿠키로 준다', async () => {
    await signUpUser();
    const login = await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'Passw0rd!x' } });
    const refresh = cookieValue(login.cookies, 'refreshToken')!;
    const res = await call('POST', '/auth/token', { headers: { 'x-refresh-token': refresh } });
    expect(res.status).toBe(200);
    const access = jwt.decode(cookieValue(res.cookies, 'accessToken')!) as { userId: number; email: string };
    expect(access.email).toBe('a@example.com');
  });

  it('갱신: 위조/만료/폐기/없음은 500이 아니라 401', async () => {
    await signUpUser();
    const login = await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'Passw0rd!x' } });
    const refresh = cookieValue(login.cookies, 'refreshToken')!;
    const expired = jwt.sign({ userId: 1 }, 'refresh-secret', { expiresIn: -10, issuer: 'Fundi' });
    const forged = jwt.sign({ userId: 1 }, 'wrong-secret', { issuer: 'Fundi' });

    for (const token of [undefined, 'garbage', forged, expired]) {
      const res = await call('POST', '/auth/token', { headers: token ? { 'x-refresh-token': token } : {} });
      expect(res.status).toBe(401);
    }

    // 로그아웃으로 폐기한 토큰
    await call('POST', '/auth/logout', { headers: { 'x-user-id': '1', 'x-refresh-token': refresh } });
    expect((await call('POST', '/auth/token', { headers: { 'x-refresh-token': refresh } })).status).toBe(401);
  });

  it('해시 저장 이전에 저장된 원문 토큰도 만료 전까지는 갱신할 수 있다', async () => {
    await signUpUser();
    const legacy = jwt.sign({ userId: 1, email: 'a@example.com' }, 'refresh-secret', { expiresIn: '7d', issuer: 'Fundi' });
    tables.Token.push({ id: 99, userId: 1, refreshToken: legacy, revoke: false, expiresAt: new Date(Date.now() + 1e6) });
    expect((await call('POST', '/auth/token', { headers: { 'x-refresh-token': legacy } })).status).toBe(200);
  });

  it('로그인할 때 만료된 이전 토큰 행을 정리한다', async () => {
    await signUpUser();
    tables.Token.push({ id: 98, userId: 1, refreshToken: 'old', revoke: false, expiresAt: new Date(Date.now() - 1000) });
    await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'Passw0rd!x' } });
    expect(tables.Token.some((t) => t.refreshToken === 'old')).toBe(false);
    expect(tables.Token).toHaveLength(1);
  });

  it('비로그인 로그아웃은 401이고 서비스는 살아 있다', async () => {
    expect((await call('POST', '/auth/logout', { headers: { 'x-refresh-token': 'x' } })).status).toBe(401);
    expect((await call('POST', '/auth/login', { body: {} })).status).toBe(400);
  });
});

// --- M2 비밀번호 ------------------------------------------------------------------
describe('M2: 비밀번호 해시', () => {
  it('새 가입자는 v2 salt(210,000회)로 저장된다', async () => {
    await signUpUser();
    expect(tables.User[0].salt.startsWith('v2$')).toBe(true);
    expect(tables.User[0].password).toBeTruthy();
  });

  it('기존(10,000회) 해시 사용자는 로그인되고 새 방식으로 재해시된다', async () => {
    const salt = crypto.randomBytes(32).toString('base64');
    const password = crypto.pbkdf2Sync('LegacyPass1', salt, 10000, 64, 'sha512').toString('base64');
    tables.User.push({ userId: 5, email: 'legacy@example.com', nickname: 'old', password, salt });
    ids.User = 6;

    expect((await call('POST', '/auth/login', { body: { email: 'legacy@example.com', password: 'wrong-pass' } })).status).toBe(401);
    const ok = await call('POST', '/auth/login', { body: { email: 'legacy@example.com', password: 'LegacyPass1' } });
    expect(ok.status).toBe(200);
    expect(tables.User[0].salt.startsWith('v2$')).toBe(true);
    expect((await call('POST', '/auth/login', { body: { email: 'legacy@example.com', password: 'LegacyPass1' } })).status).toBe(200);
  });

  it('소셜 계정(비밀번호 없음)과 없는 계정은 같은 401', async () => {
    tables.User.push({ userId: 7, email: 'social@example.com', nickname: 's', provider: 'kakao', snsId: '1' });
    const a = await call('POST', '/auth/login', { body: { email: 'social@example.com', password: 'whatever12' } });
    const b = await call('POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'whatever12' } });
    expect([a.status, b.status]).toEqual([401, 401]);
    expect(a.body).toEqual(b.body);
  });

  it('로그인 실패가 10번 쌓이면 429', async () => {
    await signUpUser();
    for (let i = 0; i < 10; i++) {
      expect((await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'wrong-pass' } })).status).toBe(401);
    }
    expect((await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'Passw0rd!x' } })).status).toBe(429);
  });

  it('비밀번호에 문자열이 아닌 값을 보내도 500이 아니다', async () => {
    expect((await call('POST', '/auth/login', { body: { email: 'a@example.com', password: { a: 1 } } })).status).toBe(400);
    expect((await call('POST', '/auth/login', { body: { email: ['a@example.com'], password: 'x' } })).status).toBe(400);
  });
});

// --- M3 쿠키 ----------------------------------------------------------------------
describe('M3: 쿠키', () => {
  it('httpOnly + sameSite=Lax, COOKIE_SECURE=true 이면 Secure', async () => {
    await signUpUser();
    const plain = await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'Passw0rd!x' } });
    expect(plain.cookies.every((c) => /HttpOnly/i.test(c) && /SameSite=Lax/i.test(c))).toBe(true);
    expect(plain.cookies.some((c) => /Secure/i.test(c))).toBe(false);

    process.env.COOKIE_SECURE = 'true';
    try {
      const secure = await call('POST', '/auth/login', { body: { email: 'a@example.com', password: 'Passw0rd!x' } });
      expect(secure.cookies).toHaveLength(2);
      expect(secure.cookies.every((c) => /Secure/i.test(c))).toBe(true);
    } finally {
      delete process.env.COOKIE_SECURE;
    }
  });
});

// --- M4 가입 ----------------------------------------------------------------------
describe('M4: 회원 가입', () => {
  const valid = async () => {
    const code = await sendAndVerify('a@example.com');
    return { nickname: 'alice', email: 'a@example.com', code, password: 'Passw0rd!x', confirm_password: 'Passw0rd!x', category_id: 1 };
  };

  it.each([
    ['비밀번호 없음', { password: undefined, confirm_password: undefined }],
    ['비밀번호 불일치', { confirm_password: 'Different1!' }],
    ['닉네임 없음', { nickname: undefined }],
    ['닉네임 46자', { nickname: 'n'.repeat(46) }],
    ['이메일 형식 오류', { email: 'nope' }],
    ['코드 없음', { code: undefined }],
    ['카테고리 없음', { category_id: undefined }],
    ['카테고리 문자열', { category_id: 'abc' }],
  ])('%s → 400이고 사용자가 만들어지지 않는다', async (_name, patch) => {
    const body = { ...(await valid()), ...patch };
    expect((await call('POST', '/auth/signup', { body })).status).toBe(400);
    expect(tables.User).toHaveLength(0);
  });

  it('존재하지 않는 카테고리면 400이고 사용자 행도 남지 않는다(트랜잭션)', async () => {
    failNext.interestCategory = 'ER_NO_REFERENCED_ROW_2';
    const res = await call('POST', '/auth/signup', { body: await valid() });
    expect(res.status).toBe(400);
    expect(tables.User).toHaveLength(0);
  });

  it('이미 가입된 이메일은 409', async () => {
    await signUpUser();
    const code = await sendAndVerify('a@example.com');
    const res = await call('POST', '/auth/signup', {
      body: { nickname: 'x', email: 'a@example.com', code, password: 'Passw0rd!x', confirm_password: 'Passw0rd!x', category_id: 1 },
    });
    expect(res.status).toBe(409);
  });

  it('가입 후 같은 인증으로 다시 가입할 수 없다', async () => {
    const body = await valid();
    expect((await call('POST', '/auth/signup', { body })).status).toBe(201);
    expect((await call('POST', '/auth/signup', { body: { ...body, email: 'a@example.com' } })).status).not.toBe(201);
    expect(tables.User).toHaveLength(1);
  });
});

// --- M6 OAuth ---------------------------------------------------------------------
describe('M6: OAuth', () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = 'gid';
    process.env.GOOGLE_REDIRECT_URI = 'https://api.example.com/oauth/google/callback';
    process.env.FRONTEND_URL = 'https://front.example.com';
  });

  it('로그인 시작: 요청마다 다른 state를 쿠키에 두고 인가 URL에 실어 보낸다(인코딩 포함)', async () => {
    const a = await call('GET', '/oauth/google');
    const b = await call('GET', '/oauth/google');
    const urlA = new URL(a.headers.get('location')!);
    const urlB = new URL(b.headers.get('location')!);
    expect(a.status).toBe(302);
    expect(urlA.searchParams.get('redirect_uri')).toBe('https://api.example.com/oauth/google/callback');
    expect(urlA.searchParams.get('state')).toBe(cookieValue(a.cookies, 'oauthState'));
    expect(urlA.searchParams.get('state')).not.toBe(urlB.searchParams.get('state'));
  });

  it('네이버도 고정값이 아닌 랜덤 state', async () => {
    process.env.NAVER_CLIENT_ID = 'nid';
    const res = await call('GET', '/oauth/naver');
    expect(new URL(res.headers.get('location')!).searchParams.get('state')).not.toBe('naverLogin');
  });

  it('콜백: state가 없거나 다르면 토큰 교환 없이 오류로 돌려보낸다', async () => {
    for (const headers of [{}, { cookie: 'oauthState=abc' }]) {
      const res = await call('GET', '/oauth/google/callback?code=xyz&state=different', { headers });
      expect(res.status).toBe(302);
      expect(new URL(res.headers.get('location')!).searchParams.get('login_error')).toBe('invalid_state');
    }
    expect(tables.User).toHaveLength(0);
  });

  it('콜백: 인가 코드가 없으면 오류로 돌려보낸다', async () => {
    const res = await call('GET', '/oauth/google/callback');
    expect(new URL(res.headers.get('location')!).searchParams.get('login_error')).toBe('missing_code');
  });
});

describe('L: 오류 처리', () => {
  it('잘못된 JSON은 400, 너무 큰 본문은 413', async () => {
    expect((await call('POST', '/auth/login', { raw: '{"email":' })).status).toBe(400);
    expect((await call('POST', '/auth/login', { body: { email: 'a@b.com', password: 'a'.repeat(20000) } })).status).toBe(413);
  });
});
