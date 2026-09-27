import { useState } from "react";
import { BackBar, Button, Field, Icon, Shell } from "@availo/ui";
import { normalisePlate } from "@availo/shared";
import { api, ApiError, OfflineError, session } from "../api.js";
import { flow } from "../flow.js";
import { navigate } from "../router.js";

/**
 * D2 · Details and vehicle (US-002, US-003, US-131). Verification is automatic;
 * the driver can book as soon as this is done (US-005).
 * The accessible-bay questions (US-004) arrive with accessible eligibility in sprint 5.
 */
export function Details() {
  const f = flow.get();
  const type = f.userType ?? "staff";
  const [name, setName] = useState("");
  const [campusId, setCampusId] = useState("");
  const [plate, setPlate] = useState("");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (!f.registrationToken) { navigate("/", true); return null; }
  const plateCheck = plate ? normalisePlate(plate) : null;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (name.trim().length < 2) errs.name = "Enter your name as it should appear on your pass.";
    if (type !== "guest" && !campusId.trim()) errs.campusIdentifier = type === "staff" ? "Enter your staff number." : "Enter your matriculation number.";
    if (!plateCheck) errs["vehicle.plate"] = "Enter your vehicle's registration number.";
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    setFormError(undefined);
    try {
      const r = await api<{ accessToken: string; refreshToken: string }>("POST", "/registrations", {
        registrationToken: f.registrationToken, name: name.trim(), userType: type,
        ...(type !== "guest" ? { campusIdentifier: campusId.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        vehicle: { plate },
      }, { auth: false });
      session.save(r);
      flow.clear();
      navigate("/home", true);
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.detail.fields)) {
        setErrors(Object.fromEntries((err.detail.fields as Array<{ path: string; message: string }>).map((x) => [x.path, x.message])));
      } else if (err instanceof ApiError && err.code === "REGISTRATION_EXPIRED") {
        flow.set({ registrationToken: "" });
        navigate("/", true);
      } else setFormError(err instanceof OfflineError ? "No connection. Your details are kept; try again when you have signal." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <BackBar title="Add your details" onBack={() => navigate("/")} />
      <form className="av-main" onSubmit={create} noValidate>
        <div className="av-ok-line"><Icon name="check" size={18} color="#1F7A4D" strokeWidth={2.6} />{f.e164} verified</div>
        <Field label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
        {type !== "guest" ? (
          <Field label={type === "staff" ? "Staff number" : "Matriculation number"} autoCapitalize="characters" value={campusId}
            onChange={(e) => setCampusId(e.target.value)} error={errors.campusIdentifier} hint="As it appears on your university ID card." />
        ) : null}
        <Field label="Vehicle plate" autoCapitalize="characters" value={plate} onChange={(e) => setPlate(e.target.value)} error={errors["vehicle.plate"]}
          hint={plateCheck?.warning ? "That doesn't look like a current Nigerian plate. Check it, or continue if it's right." : "As it appears on the plate. You can add a second vehicle later."} />
        <Field label="Email (optional)" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email}
          hint="A second way to reach you about bookings." />
        {formError ? <div className="av-banner bad" role="alert">{formError}</div> : null}
        <div className="av-spacer" />
        <Button type="submit" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
      </form>
    </Shell>
  );
}
