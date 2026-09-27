/** Sign-up progress across the first three screens. Kept for the tab's life only. */
export interface Flow { mobile?: string; e164?: string; userType?: "staff" | "student" | "guest"; registrationToken?: string }

export const flow = {
  get(): Flow {
    try { return JSON.parse(sessionStorage.getItem("av.flow") ?? "{}") as Flow; } catch { return {}; }
  },
  set(patch: Flow): void {
    try { sessionStorage.setItem("av.flow", JSON.stringify({ ...flow.get(), ...patch })); } catch { /* ignore */ }
  },
  clear(): void {
    try { sessionStorage.removeItem("av.flow"); } catch { /* ignore */ }
  },
};
