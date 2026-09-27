import { BrandBar, Chip } from "@availo/ui";
import { useGate } from "../gate.js";

const hm = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

/** The gate header: lot, attendant, and whether this phone is online and when it last synced. */
export function GateBar() {
  const g = useGate();
  const lot = g.device.client.current?.lotName || "Gate";
  const synced = g.lastSync ? ` · synced ${hm(g.lastSync)}` : "";
  return (
    <BrandBar gate subtitle={`${lot}${g.device.attendantName ? " · " + g.device.attendantName : ""}`}
      right={g.online ? <Chip tone="status" icon="online">Online{synced}</Chip> : <Chip tone="status" icon="offline">Offline{synced}</Chip>} />
  );
}
