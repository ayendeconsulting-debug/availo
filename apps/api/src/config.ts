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
  /** Ed25519 seed (32 bytes, hex) that signs passes, and the key id carried in the QR. */
  readonly passSigningKey: Uint8Array;
  readonly passKeyId: number;
  /** Master secret from which per-pass rotating-code secrets, the PIN pepper and the PIN encryption key derive. */
  readonly passMasterKey: Uint8Array;
  /** Where the driver app lives, for links in SMS and email. */
  readonly appBaseUrl: string;
  /** Browser origins allowed to call the API: the driver and gate apps. */
  readonly corsOrigins: string[];
  /**
   * Test seam for end-to-end runs: the server's clock starts at this instant and
   * runs forward in real time. Refused in production.
   */
  readonly clockStart: Date | null;
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
    passSigningKey: hex32("PASS_SIGNING_KEY", required("PASS_SIGNING_KEY", "11".repeat(32))),
    passKeyId: Number(env.PASS_KEY_ID ?? 1),
    passMasterKey: hex32("PASS_MASTER_KEY", required("PASS_MASTER_KEY", "22".repeat(32))),
    appBaseUrl: required("APP_BASE_URL", "http://localhost:5173"),
    corsOrigins: (env.CORS_ORIGINS ?? (mode === "production" ? "" : "http://localhost:5173,http://localhost:5174,http://localhost:4173,http://localhost:4174"))
      .split(",").map((s) => s.trim()).filter(Boolean),
    clockStart: clockStart(env.AVAILO_CLOCK_START, mode),
  };
}

function hex32(name: string, value: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} must be 32 bytes of hex`);
  return Uint8Array.from(value.match(/../g)!, (x) => parseInt(x, 16));
}

function clockStart(value: string | undefined, mode: AppConfig["env"]): Date | null {
  if (!value) return null;
  if (mode === "production") throw new Error("AVAILO_CLOCK_START is not allowed in production");
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("AVAILO_CLOCK_START must be an ISO 8601 date-time");
  return d;
}
