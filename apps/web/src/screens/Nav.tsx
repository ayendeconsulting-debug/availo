import { BottomNav } from "@availo/ui";
import { go } from "../router.js";

export function DriverNav({ current }: { current: "home" | "bookings" | "wallet" | "account" }) {
  return (
    <BottomNav current={current} items={[
      { key: "home", label: "Home", icon: "home", href: "/home", onClick: go("/home") },
      { key: "bookings", label: "Bookings", icon: "list", href: "/bookings", onClick: go("/bookings") },
      { key: "wallet", label: "Wallet", icon: "wallet", href: "/wallet", onClick: go("/wallet") },
      { key: "account", label: "Account", icon: "account", href: "/account", onClick: go("/account") },
    ]} />
  );
}
