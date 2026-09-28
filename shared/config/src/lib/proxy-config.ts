import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { HTTPMethod, ServiceConfig } from '@shared/config';

/** 서비스로 전달할 사용자 정보. 요청마다 만들어 넘기며 ServiceClient는 이를 저장하지 않는다. */
export interface AuthContext {
  userId?: number;
  email?: string;
  /** 리프레시 토큰이 필요한 서비스(auth-service, user-service)에만 넣는다. */
  refreshToken?: string;
}

/** 서비스가 `headerToLocals`로 읽는 헤더. 값이 없는 항목은 만들지 않는다. */
export const buildAuthHeaders = (ctx?: AuthContext): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (ctx?.userId !== undefined) {
    headers['x-user-id'] = String(ctx.userId);
    if (ctx.email) headers['x-user-email'] = ctx.email;
  }
  if (ctx?.refreshToken) headers['x-refresh-token'] = ctx.refreshToken;
  return headers;
};

export interface ForwardOptions {
  data?: unknown;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
  auth?: AuthContext;
}

/**
 * 서비스 간 호출 클라이언트.
 * 요청마다 헤더를 만들어 보내므로 요청 사이에 사용자 정보가 섞이지 않는다.
 * 2xx가 아닌 응답은 예외(AxiosError)로 던진다. 게이트웨이처럼 응답을 그대로 전달할 때만 `forward()`를 쓴다.
 */
export class ServiceClient {
  private readonly client: AxiosInstance;

  constructor(private readonly config: ServiceConfig) {
    this.client = axios.create({
      baseURL: config.url,
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /** 사용자 정보를 붙여 호출하는 클라이언트. 호출마다 새로 만들어도 비용이 없다. */
  public withAuth(auth: AuthContext) {
    const call = <T>(method: HTTPMethod, path: string, data?: unknown, params?: Record<string, unknown>) =>
      this.request<T>(method, path, { data, params, auth });

    return {
      get: <T = any>(path: string, params?: Record<string, unknown>) => call<T>('GET', path, undefined, params),
      post: <T = any>(path: string, data?: unknown) => call<T>('POST', path, data),
      put: <T = any>(path: string, data?: unknown) => call<T>('PUT', path, data),
      patch: <T = any>(path: string, data?: unknown) => call<T>('PATCH', path, data),
      delete: <T = any>(path: string, params?: Record<string, unknown>) => call<T>('DELETE', path, undefined, params),
    };
  }

  /** 서비스 응답을 상태 코드와 관계없이 그대로 돌려준다. (5xx 본문, 3xx의 Location/Set-Cookie 포함) */
  public forward<T = any>(method: HTTPMethod, path: string, options: ForwardOptions = {}): Promise<AxiosResponse<T>> {
    return this.request<T>(method, path, options, { validateStatus: () => true, maxRedirects: 0 });
  }

  public request<T = any>(
    method: HTTPMethod,
    path: string,
    options: ForwardOptions = {},
    extraConfig?: AxiosRequestConfig
  ): Promise<AxiosResponse<T>> {
    // DELETE도 본문을 받는 API가 있다. (회원 탈퇴의 비밀번호, 팔로우 취소)
    const hasBody = method !== 'GET';
    return this.client.request<T>({
      method,
      url: this.normalizePath(path),
      data: hasBody ? options.data : undefined,
      params: options.params,
      headers: { ...(options.headers ?? {}), ...buildAuthHeaders(options.auth) },
      ...extraConfig,
    });
  }

  public get<T = any>(path: string, params?: Record<string, unknown>) {
    return this.request<T>('GET', path, { params });
  }

  public post<T = any>(path: string, data?: unknown) {
    return this.request<T>('POST', path, { data });
  }

  public put<T = any>(path: string, data?: unknown) {
    return this.request<T>('PUT', path, { data });
  }

  public patch<T = any>(path: string, data?: unknown) {
    return this.request<T>('PATCH', path, { data });
  }

  public delete<T = any>(path: string, params?: Record<string, unknown>) {
    return this.request<T>('DELETE', path, { params });
  }

  /** path에 `/base` 중복이 들어오지 않도록 정리 */
  private normalizePath(path: string): string {
    const base = this.config.base.find((b) => path.startsWith(b));
    if (base) {
      // 이미 base를 포함하고 있을 때
      return path;
    }
    // 기본 basePaths[0] 사용
    return `${this.config.base[0]}${path.startsWith('/') ? '' : '/'}${path}`;
  }
}
