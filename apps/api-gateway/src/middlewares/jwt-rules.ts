import { HTTPMethod, JwtRule } from '@shared/config';

function pathToRegExp(path: string): RegExp {
  // 정규식 메타 문자는 이스케이프하고, `:id` 같은 파라미터 세그먼트는 "슬래시가 아닌 문자"로 바꾼다.
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withParams = escaped.replace(/:[^/]+/g, '[^/]+');
  return new RegExp(`^${withParams}(?:/.*)?$`);
}

/** 규칙이 구체적일수록 크다: 고정 세그먼트가 많을수록, 그다음 경로가 길수록 */
const specificity = (rule: JwtRule): [number, number] => [
  rule.path.split('/').filter((segment) => segment && !segment.startsWith(':')).length,
  rule.path.length,
];

/**
 * 요청에 로그인이 필요한지 판정한다.
 * 규칙에 맞는 경로가 없으면 **인증 필수**다. (공개 경로만 `required: false`로 열거)
 */
export function isAuthRequired(rules: JwtRule[], method: string, path: string): boolean {
  const matched = rules
    .filter((r) => (r.method === 'ALL' || r.method === (method as HTTPMethod)) && pathToRegExp(r.path).test(path))
    .sort((a, b) => {
      const [aSeg, aLen] = specificity(a);
      const [bSeg, bLen] = specificity(b);
      return bSeg - aSeg || bLen - aLen;
    });
  return matched[0]?.required ?? true;
}
