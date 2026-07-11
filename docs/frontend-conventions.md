# Frontend conventions

How the dashboard (`apps/dashboard`) handles forms, validation errors,
toasts, error pages, and pending UI. These patterns were decided once, in
[#141](https://github.com/plattegruber/well-regarded/issues/141); every
surface issue copies them instead of inventing its own. The living
reference is **Settings → Practice profile**
(`app/routes/settings.practice.tsx`) — it demonstrates the entire loop
(loader → form → action → zod → field errors → flash toast → optimistic
UI), and "go look at the practice profile page" is always a complete
answer.

Voice matters everywhere here: error messages, toasts, and empty states
follow the design language (`design/design-system/readme.md`) — sentence
case, no exclamation points, understatement over hype.

## The action recipe

Every mutation follows the same five steps, in order:

```ts
export async function action({ request, context }: Route.ActionArgs) {
  // 1. Permission check — in the action, always. Disabled buttons are
  //    not a security boundary. `can()` comes from @wellregarded/core.
  if (!can(actor, "manage_settings", { practiceId: actor.practiceId })) {
    throw data(null, { status: 403 });
  }

  // 2. Parse. Validation failures are RETURNED (422 + fieldErrors),
  //    never thrown: thrown errors mean bugs, returned data means user
  //    mistakes.
  const parsed = await parseForm(practiceProfileSchema, request);
  if (!parsed.ok) {
    return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
  }

  // 3. Mutate — and audit() in the same transaction.
  await store.update(actor.practiceId, parsed.data);

  // 4 + 5. Flash, then redirect. The toast survives navigation via the
  //    flash cookie.
  return redirect("/settings/practice", {
    headers: await setFlash(context.cloudflare.env, {
      tone: "positive",
      message: "Practice profile saved",
    }),
  });
}
```

## Form parsing: `parseForm`

`app/lib/forms.server.ts`. Wraps `schema.safeParse` over the request's
form data and flattens zod issues into `{ fieldErrors: Record<string,
string[]> }`. The schema itself lives in `packages/core` (e.g.
`practiceProfileSchema`) — boundary schemas are shared contracts, not app
code. Form data arrives as strings; schemas own coercion (`z.coerce.*`)
and empty-string-to-null normalization.

No form library (`@conform-to/react`, `remix-hook-form`) — the in-house
convention is deliberately minimal. Revisit only when a genuinely dynamic
form appears (Epic #12's consent editor is the likely trigger).

## Field errors: `Field`

`app/components/form/field.tsx` composes the design-system `Input` and
resolves the right message from `fieldErrors` by field name —
`aria-invalid` and `aria-describedby` come along for free. Two wirings:

- Plain `<Form>`: `Field` reads `useActionData().fieldErrors` itself.
- Fetcher form: pass the fetcher's errors explicitly —
  `<Field name="name" errors={fetcher.data?.fieldErrors} />` — because
  fetcher results never appear in `useActionData`.

One message renders per field; a calm form doesn't stack complaints.

## Toasts

`sonner`, restyled to the design system (square, ink border, mono title)
in `app/components/ui/toaster.tsx`; `<Toaster />` is mounted once in the
shell layout (`app/routes/shell.tsx`). Two ways to fire one:

- **Flash toast** (`setFlash` in `app/lib/flash.server.ts`): set by an
  action alongside a redirect; the root loader reads-and-clears the
  cookie, the shell fires the toast after navigation. Use for any
  mutation that redirects — this is the default.
- **Client toast** (`toast.success(...)` from `sonner`): for
  non-navigation updates only — a fetcher that stays on the page, a
  copy-to-clipboard, a background refresh notice.

The flash cookie is signed with `SESSION_SECRET`
(`.dev.vars.example`; `wrangler secret put SESSION_SECRET` in deployed
environments — see `docs/secrets.md`).

## Error boundaries and 404s

The root `ErrorBoundary` (`app/root.tsx`) is the only boundary until a
surface needs a narrower one. It distinguishes:

- **404** — a designed "This page doesn't exist" state with a link to
  `/today`. Unmatched URLs reach it through the catch-all splat route
  (`app/routes/not-found.tsx`), whose loader throws
  `data(null, { status: 404 })` so the document response carries the
  real status code.
- **Other route errors** (403, 500 thrown as `data(...)`) — status +
  message, same calm layout.
- **Unexpected errors** — a quiet apology; the stack renders in dev
  only, never in production.

Error pages are still our product: tokens, voice, and a way home.

## Pending UI

- **Navigation**: `NavigationProgress`
  (`app/components/shell/navigation-progress.tsx`), mounted once in the
  shell — a hairline accent bar that appears only when a
  navigation/submission runs longer than 150ms. No skeleton framework;
  skeletons are per-surface decisions.
- **Submission**: `SubmitButton` (`app/components/form/submit-button.tsx`)
  — disabled with a pending label ("Saving…") while its form submits.
  Pass the fetcher for fetcher forms. No spinner: the design system's
  motion rules ("never bounce, never spin") outrank the usual habit.

## Optimistic updates

The copy-paste source is `useOptimisticPracticeName` in
`app/components/shell/app-shell.tsx`: the practice-profile form submits
via `useFetcher`, and while the submission is in flight the sidebar
footer shows the pending `formData` value. Success reconciles through
revalidation; failure rolls back the same way — the fetcher's lifecycle
is the entire state machine, no manual cleanup. Copy this shape for any
mutation whose result is visible before the server confirms it.

## Which tool when

| You want | Use | Not |
| --- | --- | --- |
| A mutation that navigates (create → detail, save → refresh) | `<Form>` + action + `redirect` | fetcher |
| A mutation that stays on the page (inline edit, toggle) | `useFetcher` | `<Form>` |
| Success feedback after a redirect | flash toast (`setFlash`) | client `toast(...)` |
| Feedback with no navigation | client `toast(...)` | flash |
| "You typed something wrong" | returned `fieldErrors` (422) rendered by `Field` | throwing |
| "You may not do this" / "this doesn't exist" / bugs | `throw data(..., { status })` → ErrorBoundary | returned data |
| Show a result before the server confirms | fetcher `formData` read via `useFetchers` | manual state + cleanup |

## Testing

- Loaders/actions are plain functions — test them in the default node
  environment (`settings.practice.action.test.ts` is the model).
- Component/route rendering: `renderToString` for static assertions;
  `createRoutesStub` + Testing Library under happy-dom
  (`// @vitest-environment happy-dom`) when the test needs router state
  or interaction. Keep server code out of DOM-environment files — the
  DOM shims replace `FormData`/`Headers` with implementations the
  server runtime never sees.
