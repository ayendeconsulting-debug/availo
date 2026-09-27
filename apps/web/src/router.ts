import { useEffect, useState } from "react";

/** A small path router: real URLs, so a reload or an installed-app launch lands on the right screen. */
export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.dispatchEvent(new Event("av:navigate"));
  window.scrollTo(0, 0);
}

export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    window.addEventListener("popstate", on);
    window.addEventListener("av:navigate", on);
    return () => { window.removeEventListener("popstate", on); window.removeEventListener("av:navigate", on); };
  }, []);
  return path;
}

/** Link handler for plain anchors: keeps navigation in the app. */
export function go(to: string) {
  return (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };
}
