import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '../domain/enums';
import type { RequestWithContext } from '../common/http/request-context';

export const ROLES_KEY = 'danangmap.roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

export const Principal = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<RequestWithContext>().principal;
});
