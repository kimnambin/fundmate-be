import { DataSource } from 'typeorm';
import dotenv from 'dotenv';
import { interactionEntities } from '@shared/entities';
dotenv.config();

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: interactionEntities,
  synchronize: false,
  // 쿼리 로그에는 댓글 본문 같은 사용자 입력이 파라미터로 남으므로 오류/경고만 기록한다.
  logging: process.env.DB_LOGGING === 'true' ? true : ['error', 'warn'],
  timezone: '+09:00',
});
