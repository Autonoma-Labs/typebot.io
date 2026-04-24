// Extracted from the `POST` handler in `./route.ts` so the Autonoma Environment
// Factory can reuse the same creation path (User + default Workspace + ADMIN
// MemberInWorkspace provisioning) as the production signup endpoint. See
// autonoma/entity-audit.md for the full context on why the audit classifies
// `User` as independently_created and why re-implementing this inline in a
// factory would drop the sibling rows minted in the same transaction.
import { createId } from "@paralleldrive/cuid2";
import { env } from "@typebot.io/env";
import prisma from "@typebot.io/prisma";
import { WorkspaceRole } from "@typebot.io/prisma/enum";
import { parseWorkspaceDefaultPlan } from "@typebot.io/workspaces/parseWorkspaceDefaultPlan";
import bcrypt from "bcryptjs";

export class SignupError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type CreateUserWithDefaultWorkspaceInput = {
  email: string;
  password: string;
  name?: string | null;
};

export const createUserWithDefaultWorkspace = async ({
  email,
  password,
  name,
}: CreateUserWithDefaultWorkspaceInput) => {
  if (!email || !password) {
    throw new SignupError("Email and password are required", 400);
  }

  if (password.length < 8) {
    throw new SignupError("Password must be at least 8 characters", 400);
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    throw new SignupError("User with this email already exists", 409);
  }

  if (env.DISABLE_SIGNUP && !env.ADMIN_EMAIL?.includes(email)) {
    throw new SignupError("Sign up is currently disabled", 403);
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const user = await prisma.user.create({
    data: {
      id: createId(),
      email,
      name: name || email.split("@")[0],
      hashedPassword,
      onboardingCategories: [],
      workspaces: {
        create: {
          role: WorkspaceRole.ADMIN,
          workspace: {
            create: {
              name: name ? `${name}'s workspace` : "My workspace",
              plan: parseWorkspaceDefaultPlan(email),
            },
          },
        },
      },
    },
    include: {
      workspaces: {
        select: { workspaceId: true, role: true },
      },
    },
  });

  const defaultWorkspaceId = user.workspaces[0]?.workspaceId ?? null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    hashedPassword: user.hashedPassword,
    defaultWorkspaceId,
  };
};
