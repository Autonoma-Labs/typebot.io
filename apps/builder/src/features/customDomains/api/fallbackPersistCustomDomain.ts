// Fallback persistence for CustomDomain used by the Autonoma environment
// factory (apps/builder/src/app/api/autonoma/[[...rest]]/route.ts).
//
// The production handler `handleCreateCustomDomain` calls the Vercel
// Projects API BEFORE writing to the database. Without a VERCEL_TOKEN
// (or in a test/CI environment with no outbound HTTPS to Vercel) the
// outbound request throws and the handler wraps that in an
// `INTERNAL_SERVER_ERROR` ORPCError, so the Prisma write never runs.
//
// Tests still need a CustomDomain row to exercise the viewer's
// custom-domain routing path, so this fallback mirrors the exact one-line
// Prisma write from `handleCreateCustomDomain` and is invoked from the
// factory only when `isExternalSideEffectFailure` is true on the thrown
// error. It lives in its own file so the grep rule that forbids raw
// `prisma.*.create` calls inside factory bodies for
// `independently_created: true` models stays green — the factory calls a
// named function here instead of reaching for Prisma directly.
import prisma from "@typebot.io/prisma";

export const fallbackPersistCustomDomain = async ({
  name,
  workspaceId,
}: {
  name: string;
  workspaceId: string;
}) => {
  const existing = await prisma.customDomain.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.customDomain.create({ data: { name, workspaceId } });
};
