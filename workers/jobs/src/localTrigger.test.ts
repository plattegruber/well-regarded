import { resetEnvCache } from "@wellregarded/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { JobsBindings } from "./bindings";
import { handleLocalTrigger } from "./localTrigger";

const TRIGGER_URL = "http://localhost:8789/__local/trigger/embedding-backfill";

function makeEnv(environment = "local") {
  const create = vi.fn().mockResolvedValue({ id: "instance-1" });
  const createCsvImport = vi.fn().mockResolvedValue({ id: "instance-2" });
  const env = {
    ENVIRONMENT: environment,
    EMBEDDING_BACKFILL: { create },
    CSV_IMPORT: { create: createCsvImport },
  } as unknown as JobsBindings;
  return { env, create, createCsvImport };
}

beforeEach(() => {
  resetEnvCache();
});

describe("handleLocalTrigger", () => {
  it("creates a workflow instance and returns 202 with its id", async () => {
    const { env, create } = makeEnv();
    const response = await handleLocalTrigger(
      new Request(TRIGGER_URL, {
        method: "POST",
        body: JSON.stringify({ batchSize: 5 }),
      }),
      env,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      triggered: "embedding-backfill",
      instanceId: "instance-1",
    });
    expect(create).toHaveBeenCalledExactlyOnceWith({
      params: { batchSize: 5 },
    });
  });

  it("triggers the csv-import workflow by its own slug (#135)", async () => {
    const { env, create, createCsvImport } = makeEnv();
    const params = { importDraftId: "d-1", practiceId: "p-1" };
    const response = await handleLocalTrigger(
      new Request("http://localhost:8789/__local/trigger/csv-import", {
        method: "POST",
        body: JSON.stringify(params),
      }),
      env,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      triggered: "csv-import",
      instanceId: "instance-2",
    });
    expect(createCsvImport).toHaveBeenCalledExactlyOnceWith({ params });
    expect(create).not.toHaveBeenCalled();
  });

  it("404s an unknown workflow slug", async () => {
    const { env } = makeEnv();
    const response = await handleLocalTrigger(
      new Request("http://localhost:8789/__local/trigger/nope", {
        method: "POST",
      }),
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("csv-import");
  });

  it("treats an empty body as default params", async () => {
    const { env, create } = makeEnv();
    const response = await handleLocalTrigger(
      new Request(TRIGGER_URL, { method: "POST" }),
      env,
    );
    expect(response.status).toBe(202);
    expect(create).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("rejects malformed JSON with 400", async () => {
    const { env, create } = makeEnv();
    const response = await handleLocalTrigger(
      new Request(TRIGGER_URL, { method: "POST", body: "{nope" }),
      env,
    );
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("is hard-gated to local: 404 in every other environment", async () => {
    const { env, create } = makeEnv("prod");
    const response = await handleLocalTrigger(
      new Request(TRIGGER_URL, { method: "POST", body: "{}" }),
      env,
    );
    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("405s a GET on the trigger path and 404s other paths", async () => {
    const { env } = makeEnv();
    expect(
      (await handleLocalTrigger(new Request(TRIGGER_URL), env)).status,
    ).toBe(405);
    expect(
      (
        await handleLocalTrigger(
          new Request("http://localhost:8789/other", { method: "POST" }),
          env,
        )
      ).status,
    ).toBe(404);
  });
});
