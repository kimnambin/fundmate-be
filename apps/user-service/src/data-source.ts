import { DataSource } from 'typeorm';
import { userEntities } from '@shared/entities';
import dotenv from 'dotenv';
dotenv.config();

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: userEntities,
  synchronize: false,
  // 쿼리 로그에는 자기소개, 닉네임 등 사용자 입력이 파라미터로 남으므로 오류/경고만 기록한다.
  logging: process.env.DB_LOGGING === 'true' ? true : ['error', 'warn'],
  timezone: '+09:00',
});
