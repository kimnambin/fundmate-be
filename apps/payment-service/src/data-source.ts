import { DataSource } from 'typeorm';
import { paymentEntities } from '@shared/entities';
import dotenv from 'dotenv';
dotenv.config();

export const AppDataSource = new DataSource({
  type: 'mysql',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: paymentEntities,
  migrationsRun: false,
  synchronize: false,
  // 결제 수단(details), 배송지(address)가 쿼리 파라미터로 로그에 남지 않도록 오류/경고만 기록한다.
  logging: process.env.DB_LOGGING === 'true' ? true : ['error', 'warn'],
  timezone: '+09:00',
});
