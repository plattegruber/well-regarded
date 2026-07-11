import { defineConfig } from "drizzle-kit";

// drizzle-kit is a Node-only dev/CI tool. It must never be imported by Worker
// code — it stays in devDependencies so it is never bundled.
//
// `dbCredentials` is only consulted by `db:migrate` and `db:studio`;
// `db:generate` works without a DATABASE_URL.
//
// `schema` points at the barrel (not a glob): the barrel is what the typed
// client sees, so it is the single authority on which tables exist, and a
// glob would also sweep up `*.test.ts` files, which drizzle-kit cannot load.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
