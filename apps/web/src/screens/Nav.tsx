import { BottomNav } from "@availo/ui";
import { useMe } from "../hooks.js";
import { go } from "../router.js";

/** The third tab is the wallet for wallet drivers and payment history for drivers who pay at checkout (US-019). */
export function DriverNav({ current }: { current: "home" | "bookings" | "wallet" | "account" }) {
  const me = useMe();
  const checkout = me.data?.paymentPath === "checkout";
  return (
    <BottomNav current={current} items={[
      { key: "home", label: "Home", icon: "home", href: "/home", onClick: go("/home") },
      { key: "bookings", label: "Bookings", icon: "list", href: "/bookings", onClick: go("/bookings") },
      checkout
        ? { key: "wallet", label: "Payments", icon: "receipt", href: "/payments", onClick: go("/payments") }
        : { key: "wallet", label: "Wallet", icon: "wallet", href: "/wallet", onClick: go("/wallet") },
      { key: "account", label: "Account", icon: "account", href: "/account", onClick: go("/account") },
    ]} />
  );
}
