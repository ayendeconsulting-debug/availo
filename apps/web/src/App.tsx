import { session } from "./api.js";
import { navigate, usePath } from "./router.js";
import { Account } from "./screens/Account.js";
import { Bookings } from "./screens/Bookings.js";
import { Code } from "./screens/Code.js";
import { Details } from "./screens/Details.js";
import { Home } from "./screens/Home.js";
import { Pass } from "./screens/Pass.js";
import { Reserve } from "./screens/Reserve.js";
import { SignUp } from "./screens/SignUp.js";
import { Wallet } from "./screens/Wallet.js";

export function App() {
  const path = usePath();
  const signedIn = session.signedIn;
  const open = new Set(["/", "/code", "/details"]);
  if (!signedIn && !open.has(path)) { queueMicrotask(() => navigate("/", true)); return null; }
  if (signedIn && path === "/") { queueMicrotask(() => navigate("/home", true)); return null; }

  const pass = /^\/pass\/([0-9a-f-]{36})$/.exec(path);
  if (pass) return <Pass key={pass[1]} reservationId={pass[1]!} />;
  switch (path) {
    case "/": return <SignUp />;
    case "/code": return <Code />;
    case "/details": return <Details />;
    case "/home": return <Home />;
    case "/reserve": return <Reserve />;
    case "/bookings": return <Bookings />;
    case "/wallet": return <Wallet />;
    case "/account": return <Account />;
    default: queueMicrotask(() => navigate(signedIn ? "/home" : "/", true)); return null;
  }
}
