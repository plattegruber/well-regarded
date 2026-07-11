// The index route redirects to /today (#132): the queue is the front door.
import { redirect } from "react-router";

export function loader() {
  return redirect("/today");
}
