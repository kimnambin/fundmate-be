import { Entity, PrimaryColumn, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../auth-entities/User';

@Entity('follows')
export class Follow {
  @PrimaryColumn({ name: 'follower_id', type: 'int' })
  followerId!: number;

  @PrimaryColumn({ name: 'following_id', type: 'int' })
  followingId!: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'follower_id' })
  follower!: User;

  @ManyToOne(() => User, { onDelete: 'CASCADE', onUpdate: 'NO ACTION' })
  @JoinColumn({ name: 'following_id' })
  following!: User;
}
