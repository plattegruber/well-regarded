// Presence (#132): route skeleton + empty state, same shape as today.tsx —
// later issues swap the loader's static meta for real data.
import { EmptyState } from "~/components/empty-state";
import { PageHeader } from "~/components/shell/page-header";
import { SURFACES, surfaceIcon, surfaceTitle } from "~/lib/surfaces";
import type { Route } from "./+types/presence";

const surface = SURFACES.presence;

export function meta() {
  return [{ title: surfaceTitle(surface) }];
}

export function loader() {
  // TODO(auth): requireAuth — Epic #4 (#59).
  return { surface };
}

export default function Presence({ loaderData }: Route.ComponentProps) {
  const { surface } = loaderData;
  return (
    <>
      <PageHeader
        overline={surface.overline}
        title={surface.title}
        description={surface.description}
      />
      <EmptyState
        icon={surfaceIcon(surface)}
        heading={surface.empty.heading}
        body={surface.empty.body}
        actionLabel={surface.empty.action.label}
      />
    </>
  );
}
