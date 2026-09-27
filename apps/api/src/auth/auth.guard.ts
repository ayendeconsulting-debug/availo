import { type CanActivate, type ExecutionContext, Inject, Injectable, createParamDecorator } from "@nestjs/common";
import { TokensService, type AccessClaims } from "./tokens.service.js";

/** NFR-SEC-09: every non-auth endpoint is authenticated. Authorisation is decided server-side. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(TokensService) private readonly tokens: TokensService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; auth?: AccessClaims }>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    req.auth = await this.tokens.verifyAccess(token);
    return true;
  }
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AccessClaims => {
  return ctx.switchToHttp().getRequest<{ auth: AccessClaims }>().auth;
});
