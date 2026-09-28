import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

/**
 * 실제 express 앱(라우터 + 전역 에러 핸들러)을 띄우고 가짜 저장소 위에서 요청을 보내 검증한다.
 * DB는 사용하지 않는다.
 */

jest.mock('@shared/entities', () => ({
  Project: class Project {},
  User: class User {},
  Like: class Like {},
  Comment: class Comment {},
  interactionEntities: [],
}));

// --- 가짜 저장소 ---------------------------------------------------------------
const db = {
  projects: new Set<number>([1]),
  comments: [] as { commentId: number; userId: number; projectId: number; content: string; createdAt: Date }[],
  likes: [] as { userId: number; projectId: number }[],
  nextCommentId: 1,
};

const users: Record<number, { userId: number; nickname: string; password: string; salt: string; image?: { imageId: number } }> = {
  1: { userId: 1, nickname: 'alice', password: 'PBKDF2-HASH', salt: 'SALT', image: { imageId: 7 } },
  2: { userId: 2, nickname: 'bob', password: 'PBKDF2-HASH-2', salt: 'SALT-2' },
};

const lastQuery: { find?: Record<string, unknown> } = {};

const repos = (entity: { name?: string }) => {
  const name = (entity as { name: string }).name;
  if (name === 'Project') {
    return { exists: async ({ where }: { where: { projectId: number } }) => db.projects.has(where.projectId) };
  }
  if (name === 'Comment') {
    return {
      create: (data: Record<string, unknown>) => data,
      save: async (data: { userId: { userId: number }; project: { projectId: number }; content: string }) => {
        const saved = {
          commentId: db.nextCommentId++,
          userId: data.userId.userId,
          projectId: data.project.projectId,
          content: data.content,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        };
        db.comments.push(saved);
        // 실제 TypeORM처럼 관계로 넘긴 객체를 그대로 돌려준다.
        return { ...data, commentId: saved.commentId, createdAt: saved.createdAt };
      },
      findOne: async ({ where }: { where: { commentId: number } }) => {
        const c = db.comments.find((x) => x.commentId === where.commentId);
        return c ? { commentId: c.commentId, userId: { userId: c.userId } } : null;
      },
      delete: async ({ commentId }: { commentId: number }) => {
        db.comments = db.comments.filter((c) => c.commentId !== commentId);
      },
      find: async (options: { where: { project: { projectId: number } }; skip: number; take: number }) => {
        lastQuery.find = options as never;
        return db.comments
          .filter((c) => c.projectId === options.where.project.projectId)
          .slice(options.skip, options.skip + options.take)
          .map((c) => ({ ...c, userId: { ...users[c.userId] } }));
      },
      count: async ({ where }: { where: { userId: unknown } }) => db.comments.filter((c) => c.userId === (where.userId as number)).length,
    };
  }
  return {
    create: (data: Record<string, unknown>) => data,
    save: async (data: { userId: number; projectId: number }) => {
      if (!db.likes.some((l) => l.userId === data.userId && l.projectId === data.projectId)) db.likes.push(data);
      return data;
    },
    delete: async (where: { userId: number; projectId: number }) => {
      db.likes = db.likes.filter((l) => !(l.userId === where.userId && l.projectId === where.projectId));
    },
    find: async () => [],
    count: async ({ where }: { where: { userId: number } }) => db.likes.filter((l) => l.userId === where.userId).length,
  };
};

jest.mock('../data-source', () => ({
  AppDataSource: { getRepository: (entity: { name?: string }) => repos(entity) },
}));

// `Equal(userId)`는 값 그대로 돌려주는 것으로 대체
jest.mock('typeorm', () => ({ ...jest.requireActual('typeorm'), Equal: (v: unknown) => v }));

// --- 서버 --------------------------------------------------------------------
let server: Server;
let base: string;

beforeAll(async () => {
  const { headerToLocals, errorHandler } = await import('@shared/config');
  const likeRouter = (await import('../routes/likes')).default;
  const commentRouter = (await import('../routes/comment')).default;
  const mainRouter = (await import('../routes/interaction-main')).default;

  const app = express();
  app.use(headerToLocals);
  app.use(express.json({ limit: '20kb' }));
  app.use('/users/likes', likeRouter);
  app.use('/comment', commentRouter);
  app.use('/interactionmain', mainRouter);
  app.use(errorHandler);

  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  db.comments = [];
  db.likes = [];
  db.nextCommentId = 1;
});

const req = async (method: string, path: string, opts: { user?: number; body?: unknown; raw?: string } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.user) headers['x-user-id'] = String(opts.user);
  const res = await fetch(base + path, {
    method,
    headers,
    body: opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, text };
};

// --- H1 ----------------------------------------------------------------------
describe('H1: 댓글 작성 응답', () => {
  it('비밀번호 해시, salt, 이메일, 프로젝트 정보가 응답에 없다', async () => {
    const res = await req('POST', '/comment/1', { user: 1, body: { contents: '좋은 프로젝트네요' } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(['commentId', 'content', 'createdAt']);
    expect(res.text).not.toMatch(/PBKDF2|SALT|password|salt|email/i);
  });

  it('문서에 있던 content 필드도 허용한다', async () => {
    const res = await req('POST', '/comment/1', { user: 1, body: { content: '안녕' } });
    expect(res.status).toBe(201);
    expect(res.body.content).toBe('안녕');
  });
});

// --- H2 ----------------------------------------------------------------------
describe('H2: 비로그인 요청', () => {
  it.each([
    ['GET', '/users/likes'],
    ['POST', '/users/likes/1'],
    ['DELETE', '/users/likes/1'],
    ['POST', '/comment/1'],
    ['DELETE', '/comment/1'],
    ['GET', '/interactionmain'],
  ])('%s %s 는 401이고 서비스는 살아 있다', async (method, path) => {
    const res = await req(method, path, { body: method === 'POST' ? { contents: 'x' } : undefined });
    expect(res.status).toBe(401);
    // 이어지는 요청도 정상 처리
    expect((await req('GET', '/interactionmain', { user: 1 })).status).toBe(200);
  });
});

// --- M1 ----------------------------------------------------------------------
describe('M1: 입력 검증', () => {
  it.each([
    ['본문 없음', {}],
    ['빈 문자열', { contents: '' }],
    ['공백만', { contents: '   ' }],
    ['문자열이 아님', { contents: { a: 1 } }],
    ['501자', { contents: 'a'.repeat(501) }],
  ])('댓글 %s → 400', async (_name, body) => {
    const res = await req('POST', '/comment/1', { user: 1, body });
    expect(res.status).toBe(400);
    expect(db.comments).toHaveLength(0);
  });

  it('500자는 허용하고 앞뒤 공백은 제거한다', async () => {
    const res = await req('POST', '/comment/1', { user: 1, body: { contents: `  ${'a'.repeat(500)}  ` } });
    expect(res.status).toBe(201);
    expect(res.body.content).toHaveLength(500);
  });

  it.each(['abc', '0', '-1', '1.5', '1e3'])('잘못된 ID(%s) → 400', async (id) => {
    expect((await req('POST', `/comment/${id}`, { user: 1, body: { contents: 'x' } })).status).toBe(400);
    expect((await req('GET', `/comment/${id}`, { user: 1 })).status).toBe(400);
    expect((await req('DELETE', `/comment/${id}`, { user: 1 })).status).toBe(400);
    expect((await req('POST', `/users/likes/${id}`, { user: 1 })).status).toBe(400);
  });

  it('존재하지 않는 프로젝트 → 404 (댓글, 좋아요)', async () => {
    expect((await req('POST', '/comment/999', { user: 1, body: { contents: 'x' } })).status).toBe(404);
    expect((await req('POST', '/users/likes/999', { user: 1 })).status).toBe(404);
    expect(db.likes).toHaveLength(0);
  });

  it('잘못된 JSON 본문 → 400', async () => {
    const res = await req('POST', '/comment/1', { user: 1, raw: '{"contents":' });
    expect(res.status).toBe(400);
  });

  it('너무 큰 본문 → 413', async () => {
    const res = await req('POST', '/comment/1', { user: 1, body: { contents: 'a'.repeat(30000) } });
    expect(res.status).toBe(413);
  });
});

// --- M2 ----------------------------------------------------------------------
describe('M2: 상태 코드', () => {
  it('없는 댓글 삭제 → 404, 남의 댓글 삭제 → 403, 내 댓글 삭제 → 200', async () => {
    await req('POST', '/comment/1', { user: 1, body: { contents: 'mine' } });

    expect((await req('DELETE', '/comment/999', { user: 1 })).status).toBe(404);
    expect((await req('DELETE', '/comment/1', { user: 2 })).status).toBe(403);
    expect(db.comments).toHaveLength(1);
    expect((await req('DELETE', '/comment/1', { user: 1 })).status).toBe(200);
    expect(db.comments).toHaveLength(0);
  });

  it('좋아요 추가/취소는 멱등하다', async () => {
    expect((await req('POST', '/users/likes/1', { user: 1 })).status).toBe(200);
    expect((await req('POST', '/users/likes/1', { user: 1 })).status).toBe(200);
    expect(db.likes).toHaveLength(1);
    expect((await req('DELETE', '/users/likes/1', { user: 1 })).status).toBe(200);
    expect((await req('DELETE', '/users/likes/1', { user: 1 })).status).toBe(200);
    expect(db.likes).toHaveLength(0);
  });
});

// --- M3 ----------------------------------------------------------------------
describe('M3: 댓글 목록', () => {
  it('작성자 이미지(imgId)가 포함되고 해시는 없다', async () => {
    await req('POST', '/comment/1', { user: 1, body: { contents: 'hello' } });
    const res = await req('GET', '/comment/1', { user: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { commentId: 1, userId: 1, nickname: 'alice', imgId: 7, content: 'hello', createdAt: '2026-01-01T00:00:00.000Z' },
    ]);
    expect(res.text).not.toMatch(/PBKDF2|SALT/);
  });

  it('필요한 컬럼과 이미지 관계만 조회하고 페이지네이션을 적용한다', async () => {
    await req('GET', '/comment/1?page=3&limit=20', { user: 1 });
    const q = lastQuery.find as { relations: unknown; select: { userId: Record<string, unknown> }; skip: number; take: number };
    expect(q.relations).toEqual({ userId: { image: true } });
    expect(Object.keys(q.select.userId).sort()).toEqual(['image', 'nickname', 'userId']);
    expect([q.skip, q.take]).toEqual([40, 20]);
  });

  it('limit은 100을 넘지 못하고 잘못된 값은 기본값', async () => {
    await req('GET', '/comment/1?limit=100000&page=abc', { user: 1 });
    const q = lastQuery.find as { skip: number; take: number };
    expect([q.skip, q.take]).toEqual([0, 100]);
  });
});

describe('마이페이지 카운트', () => {
  it('좋아요/댓글 개수', async () => {
    await req('POST', '/users/likes/1', { user: 1 });
    await req('POST', '/comment/1', { user: 1, body: { contents: 'a' } });
    await req('POST', '/comment/1', { user: 1, body: { contents: 'b' } });
    expect((await req('GET', '/interactionmain', { user: 1 })).body).toEqual({ likeCount: 1, commentCount: 2 });
  });
});
