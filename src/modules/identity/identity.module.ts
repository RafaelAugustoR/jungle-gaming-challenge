import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import { APP_CONFIG } from '../../config/infrastructure.module';
import type { AppConfig } from '../../config/config';
import { apiError } from '../../shared/rest/api-error';

export const HumanRole = (role: 'viewer' | 'demo-operator') => SetMetadata('humanRole', role);
export type Principal = { subject: string; roles: string[]; providerId?: string };
@Injectable()
export class Identity implements CanActivate {
  private readonly keys;
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {
    this.keys = createRemoteJWKSet(new URL(config.keycloakJwksUrl), { timeoutDuration: 3000 });
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer \S+$/.test(authorization))
      throw apiError(401, 'UNAUTHORIZED');
    let principal: Principal;
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.keys, {
        issuer: this.config.keycloakIssuer,
        audience: 'jungle-api',
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub'],
      });
      const realm = payload.realm_access as { roles?: unknown } | undefined;
      const roles = Array.isArray(realm?.roles)
        ? realm.roles.filter((role): role is string => typeof role === 'string')
        : [];
      if (payload.azp === 'jungle-console') principal = { subject: payload.sub!, roles };
      else if (payload.azp === 'provider-a' || payload.azp === 'provider-b') {
        if (payload.providerId !== payload.azp) throw apiError(403, 'PROVIDER_IDENTITY_MISMATCH');
        principal = { subject: payload.sub!, roles: [], providerId: payload.azp };
      } else throw apiError(403, 'FORBIDDEN');
    } catch (error) {
      if (error instanceof errors.JOSEError && error.code !== 'ERR_JWKS_TIMEOUT')
        throw apiError(401, 'UNAUTHORIZED');
      if (error instanceof Error && 'getStatus' in error) throw error;
      throw apiError(503, 'INFRASTRUCTURE_UNAVAILABLE');
    }
    const role = this.reflector.getAllAndOverride<string>('humanRole', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (principal.providerId || !principal.roles.includes(role)) throw apiError(403, 'FORBIDDEN');
    request.principal = principal;
    return true;
  }
}
@Module({ providers: [Identity], exports: [Identity] })
export class IdentityModule {}
