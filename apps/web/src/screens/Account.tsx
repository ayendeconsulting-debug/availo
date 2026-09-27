import { BrandBar, Button, Row, Shell, displayPlate } from "@availo/ui";
import { session } from "../api.js";
import { useMe } from "../hooks.js";
import { local } from "../local.js";
import { navigate } from "../router.js";
import { DriverNav } from "./Nav.js";

const TYPE: Record<string, string> = { staff: "Staff", student: "Student", guest: "Guest" };
const STATE: Record<string, string> = { verified: "Verified", flagged: "Verified", pending: "Being checked", suspended: "Suspended" };

/** US-005: the driver sees their own verification state. */
export function Account() {
  const me = useMe();
  function signOut() {
    session.clear();
    local.clear();
    navigate("/", true);
  }
  return (
    <Shell>
      <BrandBar />
      <main className="av-main tight">
        <h2 className="av-h2 xl">Account</h2>
        {me.data ? (
          <div className="av-card">
            <Row label="Name" value={me.data.name} />
            <Row label="Parking as" value={TYPE[me.data.userType]} />
            <Row label="Account" value={STATE[me.data.verificationState] ?? me.data.verificationState} />
            {me.data.vehicles.map((v, i) => <Row key={v.id} label={i === 0 ? "Vehicle" : ""} value={displayPlate(v.plate)} />)}
          </div>
        ) : null}
        <div className="av-spacer" />
        <Button variant="outline" onClick={signOut}>Sign out</Button>
      </main>
      <DriverNav current="account" />
    </Shell>
  );
}
