import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Age } from '../user-entities/Age';
import { Image } from '../user-entities/Image';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn({ name: 'user_id', type: 'int' })
  userId!: number;

  @ManyToOne(() => Age, { nullable: true })
  @JoinColumn({ name: 'age_id' })
  age?: Age;

  @ManyToOne(() => Image, { nullable: true })
  @JoinColumn({ name: 'image_id' })
  image?: Image | null;

  @Column({ type: 'varchar', length: 45, default: 'FundiFriend' })
  nickname!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  email?: string;

  // 기본 조회에서 제외한다. 로그인/탈퇴처럼 필요한 곳에서만 `select`에 명시해서 읽는다.
  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  password?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, select: false })
  salt?: string;

  @Column({ type: 'text', nullable: true })
  contents?: string;

  @Column({ type: 'varchar', length: 5, nullable: true })
  gender?: string;

  @Column({ type: 'varchar', length: 10, nullable: true })
  provider?: string;

  @Column({ name: 'sns_id', type: 'varchar', length: 100, nullable: true, unique: true })
  snsId?: string;
}
