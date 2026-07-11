// Today (#132): route skeleton + empty state. Later issues replace the
// loader's static meta with the real queue; the file's shape is the
// template every surface starts from — keep it boring.
import { EmptyState } from "~/components/empty-state";
import { PageHeader } from "~/components/shell/page-header";
import {
  SURFACES,
  surfaceIcon,
  surfaceTitle,
  todayOverline,
} from "~/lib/surfaces";
import type { Route } from "./+types/today";

const surface = SURFACES.today;

export function meta() {
  return [{ title: surfaceTitle(surface) }];
}

export function loader() {
  // TODO(auth): requireAuth — Epic #4 (#59).
  return { surface, overline: todayOverline() };
}

export default function Today({ loaderData }: Route.ComponentProps) {
  const { surface, overline } = loaderData;
  return (
    <>
      <PageHeader
        overline={overline}
        title={surface.title}
        description={surface.description}
      />
      <EmptyState
        icon={surfaceIcon(surface)}
        heading={surface.empty.heading}
        body={surface.empty.body}
      />
    </>
  );
}
