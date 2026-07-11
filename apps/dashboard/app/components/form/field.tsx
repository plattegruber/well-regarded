// Field (#141): the design-system Input wired to action field errors by
// name. By default it reads `useActionData()` (the plain <Form> path); a
// fetcher-driven form passes the fetcher's errors explicitly, because
// fetcher results never appear in useActionData:
//
//   <Field name="name" label="Name" errors={fetcher.data?.fieldErrors} />
//
// Input already renders the error line and wires aria-invalid +
// aria-describedby; Field only resolves which message applies.
import { useActionData } from "react-router";

import { Input, type InputProps } from "~/components/ui/input";
import type { FieldErrors } from "~/lib/forms.server";

export interface FieldProps extends Omit<InputProps, "error" | "name"> {
  /** The form-data field name — also the key into fieldErrors. */
  name: string;
  /** Fetcher-provided errors; defaults to useActionData().fieldErrors. */
  errors?: FieldErrors;
}

export function Field({ name, errors, ...props }: FieldProps) {
  const actionData = useActionData<{ fieldErrors?: FieldErrors }>();
  const fieldErrors = errors ?? actionData?.fieldErrors;
  // One message per field: the first is the most specific in practice, and
  // a calm form doesn't stack complaints.
  const error = fieldErrors?.[name]?.[0];
  return <Input name={name} error={error} {...props} />;
}
