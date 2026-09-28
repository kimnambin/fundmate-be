export const IMAGE_URL_MAX_LENGTH = 255;

/**
 * 이미지 URL은 https이고 우리가 발급한 업로드 주소만 허용한다.
 * 허용 접두사: `IMAGE_URL_PREFIXES`(쉼표 구분) 또는 `AWS_BUCKET`의 S3 주소. 둘 다 없으면 https 여부만 검사한다.
 * (임의의 외부 주소를 저장하면 추적 픽셀이나 악성 링크로 쓰일 수 있다)
 */
export const isAllowedImageUrl = (value: string): boolean => {
  if (value.length > IMAGE_URL_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;

  const configured = (process.env.IMAGE_URL_PREFIXES ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const prefixes = configured.length > 0 ? configured : process.env.AWS_BUCKET ? [`https://${process.env.AWS_BUCKET}.s3.`] : [];
  return prefixes.length === 0 || prefixes.some((prefix) => value.startsWith(prefix));
};
