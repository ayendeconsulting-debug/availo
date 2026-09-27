import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// NFR-ARC-07: an installable web app with no native-only dependency.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      manifest: {
        name: "Availo Gate",
        short_name: "Availo Gate",
        description: "Verify passes and record entry and exit at the gate.",
        start_url: "/",
        display: "standalone",
        background_color: "#F7F6F2",
        theme_color: "#1E2124",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // The whole app is precached: the gate must open and verify with no network at all (NFR-OFF-02).
        globPatterns: ["**/*.{js,css,html,woff2,png,svg}"],
        navigateFallback: "index.html",
        // API responses are never cached by the service worker; the app keeps what it needs itself.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
});
