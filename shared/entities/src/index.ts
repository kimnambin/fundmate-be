import { Age } from './user-entities/Age';
import { Category } from './auth-entities/Category';
import { EmailVerification } from './auth-entities/EmailVerification';
import { Image } from './user-entities/Image';
import { InterestCategory } from './auth-entities/InterestCategory';
import { Token } from './auth-entities/Token';
import { User } from './auth-entities/User';
import { Follow } from './user-entities/Follow';
import { Project } from './funding-entities/Project';
import { OptionData } from './funding-entities/OptionData';
import { Like } from './interaction-entities/Like';
import { Comment } from './interaction-entities/Comment';
import { PaymentHistory } from './payment-entities';
import { PaymentSchedule } from './payment-entities';
import { PaymentInfo } from './payment-entities';

export { Age, Category, EmailVerification, Image, InterestCategory, Token, User, Follow };
export { Project, OptionData };
export { PaymentHistory, PaymentSchedule, PaymentInfo };
export { Like, Comment };

export const authEntities = [Age, Category, EmailVerification, Image, InterestCategory, Token, User];
// 관계로 이어진 엔티티만 등록한다. (인증/토큰/이메일 인증 테이블과 결제 이력은 이 서비스에 필요 없다)
export const fundingEntities = [Project, OptionData, User, Age, Image, Category, Like, Comment, PaymentSchedule, PaymentInfo];
export const userEntities = [Age, Category, Image, InterestCategory, User, Follow, Token];
export const interactionEntities = [User, Project, Like, Age, Image, Category, OptionData, Comment, PaymentSchedule, PaymentInfo];
export const paymentEntities = [...new Set([PaymentHistory, PaymentInfo, PaymentSchedule, ...fundingEntities])];
