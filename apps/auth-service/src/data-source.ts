import { DataSource } from 'typeorm';
import { authEntities } from '@shared/entities';
import dotenv from 'dotenv';
dotenv.config();

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: authEntities,
  migrationsRun: false,
  synchronize: false,
  // 쿼리 로그에는 비밀번호 해시, 리프레시 토큰, 인증 코드가 파라미터로 남으므로 오류/경고만 기록한다.
  logging: process.env.DB_LOGGING === 'true' ? true : ['error', 'warn'],
  timezone: '+09:00',
  charset: 'utf8mb4',
});
