import { index, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  // Resource route (no component): deploy verification, curled by Epic #2.
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
