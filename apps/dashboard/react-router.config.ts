import type { Config } from "@react-router/dev/config";

export default {
  // Server-render on the Workers runtime; the fetch handler lives in
  // workers/app.ts.
  ssr: true,
  future: {
    // Required for @cloudflare/vite-plugin's `viteEnvironment: { name: "ssr" }`
    // integration (the server build runs inside the plugin's workerd
    // environment instead of Node). Named `unstable_viteEnvironmentApi` in
    // older react-router 7.x — renamed to `v8_*` in 7.16.
    v8_viteEnvironmentApi: true,
  },
} satisfies Config;
