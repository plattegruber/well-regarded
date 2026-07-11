import { defineConfig } from "drizzle-kit";

// drizzle-kit is a Node-only dev/CI tool. It must never be imported by Worker
// code — it stays in devDependencies so it is never bundled.
//
// `dbCredentials` is only consulted by `db:migrate` and `db:studio`;
// `db:generate` works without a DATABASE_URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/*.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
