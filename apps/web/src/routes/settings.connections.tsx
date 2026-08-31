import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/settings/connections")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/remote-servers", replace: true });
  },
  component: () => null,
});
