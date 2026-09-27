/** Configuration read once from the environment. Secrets never have code defaults outside development. */
export interface AppConfig {
  readonly env: "development" | "test" | "production";
  readonly databaseUrl: string;
  readonly jwtSecret: Uint8Array;
  readonly otpPepper: string;
  readonly smsProvider: "dev";
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly registrationTokenTtlSeconds: number;
}

export const APP_CONFIG = Symbol("APP_CONFIG");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const mode = (env.NODE_ENV ?? "development") as AppConfig["env"];
  const required = (name: string, devDefault: string): string => {
    const v = env[name];
    if (v) return v;
    if (mode === "production") throw new Error(`${name} must be set in production`);
    return devDefault;
  };
  const smsProvider = (env.SMS_PROVIDER ?? "dev") as AppConfig["smsProvider"];
  if (mode === "production" && smsProvider === "dev") {
    throw new Error("SMS_PROVIDER=dev is not allowed in production");
  }
  return {
    env: mode,
    databaseUrl: required("DATABASE_URL", "postgres://postgres@localhost:5432/availo_dev"),
    jwtSecret: new TextEncoder().encode(required("JWT_SECRET", "dev-only-jwt-secret-change-me-0123456789")),
    otpPepper: required("OTP_PEPPER", "dev-only-otp-pepper"),
    smsProvider,
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlSeconds: 30 * 24 * 3600,
    registrationTokenTtlSeconds: 15 * 60,
  };
}
