// Placeholder index route. The design system (#115) and the nine product
// surfaces (#132) replace this — keep it to the app name and nothing else.
export function meta() {
  return [{ title: "Well Regarded" }];
}

export default function Home() {
  return (
    <main>
      <h1>Well Regarded</h1>
      <p>The dashboard shell is running.</p>
    </main>
  );
}
