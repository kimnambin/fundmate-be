import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, ManyToOne, JoinColumn, Index } from 'typeorm';
import { User } from './User';

@Entity('tokens')
export class Token {
  @PrimaryGeneratedColumn({ type: 'int' })
  id!: number;

  @ManyToOne(() => User, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user!: User;

  // 리프레시 토큰 원문이 아니라 SHA-256(hex, 64자)을 저장한다. 이전에 저장된 원문 행도 만료 전까지는 조회된다.
  // 갱신/로그아웃마다 이 컬럼으로 조회하므로 인덱스가 필요하다. (운영 DB: CREATE INDEX idx_tokens_refresh_token ON tokens (refresh_token))
  @Index('idx_tokens_refresh_token')
  @Column({ name: 'refresh_token', type: 'varchar', length: 255 })
  refreshToken!: string;

  @Column({ type: 'boolean', default: false })
  revoke!: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamp' })
  expiresAt!: Date;
}
