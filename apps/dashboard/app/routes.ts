import {
  index,
  layout,
  type RouteConfig,
  route,
} from "@react-router/dev/routes";

export default [
  // App shell (#115) wraps all product routes. The nine surface routes
  // arrive with the skeleton issue (#132).
  layout("routes/shell.tsx", [
    index("routes/home.tsx"),
    // Dev-only design-system reference; its loader 404s in production.
    route("styleguide", "routes/styleguide.tsx"),
  ]),
  // Resource route (no component): deploy verification, curled by Epic #2.
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
