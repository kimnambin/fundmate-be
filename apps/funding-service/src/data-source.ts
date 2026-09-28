import 'reflect-metadata';
import { DataSource } from 'typeorm';
import dotenv from 'dotenv';
import { fundingEntities } from '@shared/entities';
dotenv.config();

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: fundingEntities,
  migrationsRun: false,
  synchronize: false,
  // 프로젝트 설명 같은 긴 본문이 파라미터로 남으므로 오류/경고만 기록한다.
  logging: process.env.DB_LOGGING === 'true' ? true : ['error', 'warn'],
  timezone: '+09:00',
  charset: 'utf8mb4',
});
