// Extracted from the inline `suppressEmail` helper in `./handleUnsubscribeEmail.ts`
// so the Autonoma Environment Factory can reuse the same upsert path for
// SuppressedEmail rows as the production unsubscribe endpoint. See
// autonoma/entity-audit.md — SuppressedEmail is marked `needs_extraction: true`
// because the creation logic was originally a private helper inside the route.
import prisma from "@typebot.io/prisma";
import { normalizeEmail } from "@typebot.io/user/normalizeEmail";

export const suppressEmail = async (email: string) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const now = new Date();
  const record = await prisma.suppressedEmail.upsert({
    where: { email: normalized },
    update: { suppressedAt: now },
    create: { email: normalized, suppressedAt: now },
  });
  return record;
};
