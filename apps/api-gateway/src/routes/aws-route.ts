import { Router } from 'express';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { StatusCodes } from 'http-status-codes';

/** 업로드를 허용하는 콘텐츠 타입과 저장 확장자. 파일 이름은 키에 넣지 않는다. */
export const ALLOWED_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export interface UploadStorage {
  presignPut(key: string, contentType: string, options: { expiresIn: number; contentLength?: number }): Promise<string>;
  exists(key: string): Promise<boolean>;
  publicUrl(key: string): string;
}

export class AwsS3Service implements UploadStorage {
  constructor(private readonly client: S3Client) {}

  async presignPut(key: string, contentType: string, { expiresIn, contentLength }: { expiresIn: number; contentLength?: number }) {
    const cmd = new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET,
      Key: key,
      ContentType: contentType,
      // 서명에 길이를 포함하면 다른 크기의 파일로는 업로드할 수 없다.
      ...(contentLength === undefined ? {} : { ContentLength: contentLength }),
    });
    return getSignedUrl(this.client, cmd, { expiresIn });
  }

  async exists(key: string) {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: process.env.AWS_BUCKET, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (err as Error).name === 'NotFound') return false;
      throw err;
    }
  }

  publicUrl(key: string) {
    const region = process.env.AWS_REGION;
    const host = region ? `${process.env.AWS_BUCKET}.s3.${region}.amazonaws.com` : `${process.env.AWS_BUCKET}.s3.amazonaws.com`;
    return `https://${host}/${key}`;
  }
}

/** 환경변수에 자격 증명이 있을 때만 지정한다. 없으면 SDK 기본 체인(IAM 역할 등)을 쓴다. */
const createS3Client = () =>
  new S3Client({
    region: process.env.AWS_REGION,
    ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  });

const KEY_PATTERN = /^uploads\/(\d+)\/\d+-[0-9a-f-]{36}\.(jpg|png|webp|gif)$/;

/** 이 라우터는 로그인한 사용자만 접근하도록 앞단에 `jwtMiddleware(true)`를 둔다. (main.ts) */
export const createAwsRouter = (storage: UploadStorage, maxBytes = DEFAULT_MAX_UPLOAD_BYTES) => {
  const router = Router();

  router.get('/presign', async (req, res) => {
    try {
      const { contentType, size } = req.query;
      const extension = typeof contentType === 'string' ? ALLOWED_CONTENT_TYPES[contentType] : undefined;

      if (!extension) {
        return res.status(StatusCodes.BAD_REQUEST).json({
          message: `contentType은 ${Object.keys(ALLOWED_CONTENT_TYPES).join(', ')} 중 하나여야 합니다.`,
        });
      }

      // size는 선택이지만 보내면 서명에 포함되어 그 크기의 파일만 올릴 수 있다.
      let contentLength: number | undefined;
      if (size !== undefined) {
        contentLength = typeof size === 'string' && /^\d+$/.test(size) ? Number(size) : NaN;
        if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maxBytes) {
          return res
            .status(StatusCodes.BAD_REQUEST)
            .json({ message: `size는 1 ~ ${maxBytes} 바이트여야 합니다.` });
        }
      }

      const key = `uploads/${res.locals.user.userId}/${Date.now()}-${randomUUID()}.${extension}`;
      const url = await storage.presignPut(key, contentType as string, { expiresIn: 60, contentLength });

      return res.status(StatusCodes.OK).json({ url, key });
    } catch (err) {
      console.error('Presign URL 생성 실패:', (err as Error).message);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: 'Presign URL 생성 중 오류가 발생했습니다.' });
    }
  });

  router.post('/complete', async (req, res) => {
    const key = req.body?.key;
    const match = typeof key === 'string' ? KEY_PATTERN.exec(key) : null;

    // 내가 발급받은 키만 인정한다. (버킷의 다른 경로나 남의 파일 URL을 만들어 주지 않음)
    if (!match || Number(match[1]) !== res.locals.user.userId) {
      return res.status(StatusCodes.BAD_REQUEST).json({ message: '올바른 key가 필요합니다' });
    }

    try {
      if (!(await storage.exists(key))) {
        return res.status(StatusCodes.BAD_REQUEST).json({ message: '업로드된 파일을 찾을 수 없습니다.' });
      }
      return res.json({ message: '업로드 완료', url: storage.publicUrl(key) });
    } catch (err) {
      console.error('업로드 확인 실패:', (err as Error).message);
      return res.status(StatusCodes.INTERNAL_SERVER_ERROR).json({ message: '업로드 완료 중 오류가 발생했습니다.' });
    }
  });

  return router;
};

let defaultRouter: Router | undefined;

/** 실제 S3를 쓰는 라우터. 환경변수가 준비된 뒤(main.ts에서 dotenv 로드 후) 처음 요청 때가 아니라 등록 시점에 만든다. */
export const awsRouter = () => {
  defaultRouter ??= createAwsRouter(
    new AwsS3Service(createS3Client()),
    Number(process.env.UPLOAD_MAX_BYTES) || DEFAULT_MAX_UPLOAD_BYTES
  );
  return defaultRouter;
};
