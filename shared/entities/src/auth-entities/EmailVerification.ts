import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';

@Entity('email_verification')
export class EmailVerification {
  @PrimaryGeneratedColumn({ name: 'verification_id', type: 'int' })
  verificationId!: number;

  // 인증 조회는 항상 email로 한다. (운영 DB에는 인덱스를 직접 추가해야 한다: CREATE INDEX idx_email_verification_email ON email_verification (email))
  @Index('idx_email_verification_email')
  @Column({ type: 'varchar', length: 100 })
  email!: string;

  @Column({ type: 'varchar', length: 10 })
  code!: string;

  @Column({ name: 'is_used', type: 'boolean', default: false })
  isUsed!: boolean;

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt!: Date;
}
