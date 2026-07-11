// Placeholder index route inside the app shell. The nine product surfaces
// (#132) replace this with real routes and intentional empty states.
import { PageHeader } from "~/components/shell/page-header";

export function meta() {
  return [{ title: "Well Regarded" }];
}

export default function Home() {
  return (
    <PageHeader
      overline="Dashboard"
      title="Well Regarded"
      description="The shell is running. The product surfaces arrive with the route skeletons."
    />
  );
}
