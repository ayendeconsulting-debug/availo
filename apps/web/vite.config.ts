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
        name: "Availo",
        short_name: "Availo",
        description: "Reserve parking at the UNILAG pilot lot.",
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
        // The app shell and fonts are precached so an issued pass opens with no signal (NFR-OFF-06).
        globPatterns: ["**/*.{js,css,html,woff2,png,svg}"],
        navigateFallback: "index.html",
        // API responses are never cached by the service worker; the app keeps what it needs itself.
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
});
