// Settings → Imports → New import (#133): the deliberately minimal entry
// point of the CSV import journey — pick a file, upload with progress,
// hand the draft id to the mapping wizard (#134, the UX centerpiece; a
// placeholder note stands in until it lands).
//
// The upload deliberately does NOT go through a React Router action: the
// file goes browser → API worker as a raw `text/csv` body (`POST
// /api/imports/csv`), which streams cleanly and keeps the 50MB payload
// out of the dashboard worker entirely (issue #133 implementation note).
// XHR rather than fetch for one reason only: upload progress events.
//
// TODO(auth): requireAuth — Epic #4 (#59). Until Clerk wiring lands in the
// dashboard, the API call authenticates only in local dev setups where a
// session cookie is present; the screen's file-picker/progress/hand-off
// loop is the deliverable here, matching the stubbed practice-store state
// of the other settings pages.
import { CSV_IMPORT_MAX_BYTES } from "@wellregarded/core";
import { useRef, useState } from "react";
import { Link } from "react-router";

import { PageHeader } from "~/components/shell/page-header";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import type { Route } from "./+types/settings.imports";

export function meta() {
  return [{ title: "Imports · Well Regarded" }];
}

/**
 * The env slice this page needs, structural on purpose (same pattern as
 * FlashEnv in flash.server.ts): `API_URL` is set per environment in
 * wrangler.jsonc; local dev falls back to the api worker's fixed port.
 */
export interface ImportsEnv {
  API_URL?: string;
}

export async function loader({ context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as ImportsEnv;
  return { apiUrl: env.API_URL ?? "http://localhost:8787" };
}

type UploadState =
  | { phase: "idle" }
  | { phase: "uploading"; percent: number }
  | {
      phase: "done";
      importDraftId: string;
      headers: string[];
      rowsPreviewed: number;
    }
  | { phase: "error"; message: string };

/** Upload via XHR (for progress events) and resolve with the response. */
function uploadCsv(
  apiUrl: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${apiUrl}/api/imports/csv?filename=${encodeURIComponent(file.name)}`;
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "text/csv");
    // Same-site session cookie (__session) authenticates the staff call.
    xhr.withCredentials = true;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      try {
        resolve({
          status: xhr.status,
          body: JSON.parse(xhr.responseText) as Record<string, unknown>,
        });
      } catch {
        resolve({ status: xhr.status, body: {} });
      }
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.send(file);
  });
}

export default function Imports({ loaderData }: Route.ComponentProps) {
  const { apiUrl } = loaderData;
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>({ phase: "idle" });

  async function handleUpload() {
    if (!file) return;
    if (file.size > CSV_IMPORT_MAX_BYTES) {
      setState({
        phase: "error",
        message: "CSV uploads are capped at 50MB. Split the export and retry.",
      });
      return;
    }
    setState({ phase: "uploading", percent: 0 });
    try {
      const { status, body } = await uploadCsv(apiUrl, file, (percent) =>
        setState({ phase: "uploading", percent }),
      );
      if (status === 201 && typeof body.importDraftId === "string") {
        setState({
          phase: "done",
          importDraftId: body.importDraftId,
          headers: (body.headers as string[]) ?? [],
          rowsPreviewed: Array.isArray(body.previewRows)
            ? body.previewRows.length
            : 0,
        });
      } else {
        setState({
          phase: "error",
          message:
            typeof body.message === "string"
              ? body.message
              : "Upload failed. Check the file and try again.",
        });
      }
    } catch {
      setState({
        phase: "error",
        message: "Couldn't reach the server. Check your connection and retry.",
      });
    }
  }

  const uploading = state.phase === "uploading";

  return (
    <>
      <PageHeader
        overline="Settings · imports"
        title="New import"
        description="Bring past reviews and testimonials in from another system's CSV export."
      />
      <div className="flex max-w-130 flex-col gap-3.5">
        <Card title="Upload a CSV">
          <p className="m-0 mb-3.5 text-small text-gray-600">
            Export as CSV (UTF-8) from your old system — up to 50MB. You'll
            match its columns to Well Regarded fields in the next step.
          </p>
          <div className="flex items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept=".csv,text/csv"
              className="text-small text-ink-900 file:mr-3 file:cursor-pointer file:border file:border-ink-900 file:bg-surface-card file:px-3 file:py-2 file:font-mono file:text-label file:font-semibold file:uppercase file:tracking-label"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setState({ phase: "idle" });
              }}
              disabled={uploading}
            />
            <Button
              onClick={handleUpload}
              disabled={file === null || uploading}
            >
              {uploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
          {state.phase === "uploading" && (
            <div className="mt-3.5">
              <div className="h-1.5 w-full bg-gray-100">
                <div
                  className="h-1.5 bg-ink-900 transition-[width] duration-150 ease-out"
                  style={{ width: `${state.percent}%` }}
                />
              </div>
              <p className="m-0 mt-1.5 font-mono text-2xs uppercase tracking-label text-gray-500">
                {state.percent}%
              </p>
            </div>
          )}
          {state.phase === "error" && (
            <p className="m-0 mt-3.5 text-small text-red-700" role="alert">
              {state.message}
            </p>
          )}
        </Card>
        {state.phase === "done" && (
          <Card title="Uploaded" sunken>
            <p className="m-0 text-small text-gray-600">
              Found {state.headers.length} columns
              {state.rowsPreviewed > 0
                ? ` and previewed ${state.rowsPreviewed} rows`
                : ""}
              . Import draft{" "}
              <span className="font-mono">{state.importDraftId}</span> is saved
              — the column-mapping wizard picks it up from here (arrives with
              #134).
            </p>
          </Card>
        )}
        <p className="m-0 text-small text-gray-500">
          <Link to="/settings" className="text-ink-900 underline">
            Back to settings
          </Link>
        </p>
      </div>
    </>
  );
}
