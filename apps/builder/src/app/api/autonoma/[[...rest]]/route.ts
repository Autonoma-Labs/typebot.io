// Autonoma Environment Factory endpoint for the Typebot builder app.
//
// This handler responds to `discover` / `up` / `down` requests from the
// Autonoma test runner. For every model in autonoma/entity-audit.md with
// `independently_created: true` we register a factory that calls the real
// creation function in the codebase — this keeps test data flowing through
// the same business logic (password hashing, inline Workspace/Member
// provisioning, trackEvents, sanitizers, …) that production uses.
//
// Models marked `independently_created: false` (Answer, Webhook, BannedIp,
// ClaimableCustomPlan) intentionally get no factory: the SDK falls back to a
// raw SQL INSERT, which is the documented path for rows that have no
// dedicated creation helper in the application.
//
// See autonoma/.factory-plan.md for the per-model decision record.

import { defineFactory } from "@autonoma-ai/sdk";
import { prismaExecutor } from "@autonoma-ai/sdk-prisma";
import { createHandler } from "@autonoma-ai/server-web";
import { encode as encodeNextAuthJwt } from "@auth/core/jwt";
import { createId } from "@paralleldrive/cuid2";
import { createAuthPrismaAdapter } from "@typebot.io/auth/helpers/createAuthPrismaAdapter";
import { saveLog } from "@typebot.io/bot-engine/logs/saveLog";
import { insertMediaIdToCache } from "@typebot.io/bot-engine/mediaCache/insertMediaIdToCache";
import { saveAnswer } from "@typebot.io/bot-engine/queries/saveAnswer";
import { saveSetVariableHistoryItemsForFactory } from "@typebot.io/bot-engine/queries/saveSetVariableHistoryItemsForFactory";
import { saveVisitedEdges } from "@typebot.io/bot-engine/queries/saveVisitedEdges";
import { upsertResult } from "@typebot.io/bot-engine/queries/upsertResult";
import { upsertSession } from "@typebot.io/chat-session/queries/upsertSession";
import { env } from "@typebot.io/env";
import prisma from "@typebot.io/prisma";
import { createCoupon } from "@typebot.io/prisma/admin/createCoupon";
import { SpaceCreateInputSchema } from "@typebot.io/spaces/application/SpacesRepo";
import { createSpaceForFactory } from "@typebot.io/spaces/drivers/factory/createSpaceForFactory";
import { Schema } from "effect";
import {
  SignupError,
  createUserWithDefaultWorkspace,
} from "@/app/api/auth/signup/createUserWithDefaultWorkspace";
import { handleCreateInvitation } from "@/features/collaboration/api/handleCreateInvitation";
import { handleCreateCredentials } from "@/features/credentials/api/handleCreateCredentials";
import { fallbackPersistCustomDomain } from "@/features/customDomains/api/fallbackPersistCustomDomain";
import { handleCreateCustomDomain } from "@/features/customDomains/api/handleCreateCustomDomain";
import { suppressEmail } from "@/features/emails/api/suppressEmail";
import { handleCreateFolder } from "@/features/folders/api/handleCreateFolder";
import { handleSaveThemeTemplate } from "@/features/theme/api/handleSaveThemeTemplate";
import { handleCreateTypebot } from "@/features/typebot/api/handleCreateTypebot";
import { handlePublishTypebot } from "@/features/typebot/api/handlePublishTypebot";
import { handleCreateApiToken } from "@/features/user/server/handleCreateApiToken";
import { handleCreateWorkspaceInvitation } from "@/features/workspace/api/handleCreateWorkspaceInvitation";
import { handleCreateWorkspace } from "@/features/workspace/api/handleCreateWorkspace";

// Default test password used for every factory-created User.
// Returned from the auth callback so Autonoma can sign in through the
// real NextAuth Credentials provider (apps/builder/.../providers.ts:21).
const DEFAULT_TEST_PASSWORD = "Owner-pass-123!";

// Lookup a refs entry by _ref alias or raw id. Factories receive fields
// with FKs already resolved by the SDK — these helpers are only needed
// when the factory has to fetch more fields than the resolved FK id
// (e.g. the owner user's email to satisfy handleCreateWorkspace's context).
const refLookup = (
  refs: Record<string, Record<string, unknown>[]>,
  model: string,
  id: string,
) => refs[model]?.find((record) => record.id === id);

// The Autonoma SDK's PrismaClient shape only requires `$queryRawUnsafe`
// and `$transaction`. Prisma v7's full typed client is wider than that
// minimal interface; we bind through a local wrapper that matches the SDK
// contract exactly (delegating to the real client).
//
// We also raise the interactive-transaction timeout from Prisma's default
// 5 seconds to 120 seconds because the SDK's `up` wraps every factory
// call inside a single `$transaction`, and our factories delegate to the
// real domain handlers (`handleCreateTypebot`, `handlePublishTypebot`,
// `handleCreateCustomDomain`, …) which do their own Prisma queries plus
// outbound HTTP (Vercel, SMTP, telemetry). The `large` scenario alone
// creates 100 typebots and 500 results, which easily exceeds 5s.
const TRANSACTION_OPTIONS = { timeout: 300_000, maxWait: 15_000 } as const;
type AutonomaPrismaClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $transaction<T>(
    fn: (tx: AutonomaPrismaClient) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T>;
};
const wrapPrisma = (client: {
  $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
  $transaction: (
    fn: (tx: unknown) => Promise<unknown>,
    options?: { timeout?: number; maxWait?: number },
  ) => Promise<unknown>;
}): AutonomaPrismaClient => ({
  $queryRawUnsafe: (query, ...values) =>
    client.$queryRawUnsafe(query, ...values) as Promise<never>,
  $transaction: (fn, options) =>
    client.$transaction(
      (tx) => fn(wrapPrisma(tx as never)),
      options ?? TRANSACTION_OPTIONS,
    ) as Promise<never>,
});
const autonomaExecutor = prismaExecutor(wrapPrisma(prisma));

// Vercel preview deployments build with NODE_ENV=production, which trips the
// SDK's production guard. We opt-in via AUTONOMA_ENABLED so the guard still
// fires for real production (where the env var is absent), but preview and
// staging environments can host the factory endpoint.
export const POST = createHandler({
  executor: autonomaExecutor,
  scopeField: "workspaceId",
  sharedSecret: process.env.AUTONOMA_SHARED_SECRET!,
  signingSecret: process.env.AUTONOMA_SIGNING_SECRET!,
  allowProduction: process.env.AUTONOMA_ENABLED === "true",

  factories: {
    // User — Branch 1 (extraction already completed).
    // Calls the extracted helper from apps/builder/src/app/api/auth/signup/
    // createUserWithDefaultWorkspace.ts so the User + default Workspace +
    // ADMIN MemberInWorkspace all land atomically, just like the credentials
    // signup endpoint does.
    User: defineFactory({
      create: async (data) => {
        const email = String(data.email);
        const name = data.name ? String(data.name) : null;
        try {
          const user = await createUserWithDefaultWorkspace({
            email,
            password: DEFAULT_TEST_PASSWORD,
            name,
          });
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            defaultWorkspaceId: user.defaultWorkspaceId,
          };
        } catch (error) {
          if (error instanceof SignupError) {
            throw new Error(`User factory failed (${error.status}): ${error.message}`);
          }
          throw error;
        }
      },
      // The default Workspace minted inline by createUserWithDefaultWorkspace
      // is a side-effect row that the SDK's ref-based teardown cannot see
      // (it is never added to `refs.Workspace` unless the scenario also
      // declared a Workspace node that the factory resolved to the same id).
      // Workspace does NOT cascade when a User is deleted (MemberInWorkspace
      // cascades from both sides, but Workspace has no FK to User), so
      // without this teardown the default workspace leaks after `down`.
      // `deleteMany` is idempotent — if the Workspace factory already
      // registered the same id and the SDK deleted it first, this is a
      // no-op. Everything workspace-scoped (Typebot, Folder, Credentials,
      // Result, etc.) cascades on Workspace delete, so this is a safe
      // catch-all for the side-effect row.
      teardown: async (record) => {
        const defaultWorkspaceId = record.defaultWorkspaceId
          ? String(record.defaultWorkspaceId)
          : null;
        if (defaultWorkspaceId) {
          await prisma.workspace.deleteMany({
            where: { id: defaultWorkspaceId },
          });
        }
        await prisma.user.deleteMany({ where: { id: String(record.id) } });
      },
    }),

    // Workspace — Branch 2.
    // Typebot's signup auto-mints a default Workspace + ADMIN member for
    // the new user. Scenarios almost always re-declare that same workspace
    // with a specific name/plan/icon, so we reuse the auto-created one
    // rather than calling handleCreateWorkspace a second time (which would
    // also enforce FREE-plan cooldowns and duplicate-name rejection).
    // Only when we can see no default workspace on the owner do we fall
    // through to handleCreateWorkspace — which is the path that exercises
    // the "user creates an additional workspace" flow.
    Workspace: defineFactory({
      create: async (data, ctx) => {
        const userId = data.userId ? String(data.userId) : null;
        const owner = userId ? refLookup(ctx.refs, "User", userId) : null;
        const defaultWorkspaceId = owner?.defaultWorkspaceId
          ? String(owner.defaultWorkspaceId)
          : null;

        if (defaultWorkspaceId) {
          const updated = await prisma.workspace.update({
            where: { id: defaultWorkspaceId },
            data: {
              name: data.name ? String(data.name) : undefined,
              plan: data.plan ? (String(data.plan) as never) : undefined,
              icon: data.icon !== undefined ? (data.icon as string | null) : undefined,
              isVerified:
                data.isVerified !== undefined ? Boolean(data.isVerified) : undefined,
            },
          });
          return { id: updated.id };
        }

        if (!userId)
          throw new Error(
            "Workspace factory requires a parent User (no userId resolved).",
          );
        const ownerEmail = owner?.email ? String(owner.email) : "";
        const { workspace } = await handleCreateWorkspace({
          input: {
            name: data.name ? String(data.name) : "Workspace",
            icon: data.icon ? String(data.icon) : undefined,
          },
          context: { user: { id: userId, email: ownerEmail } },
        });
        if (data.plan || data.isVerified !== undefined) {
          await prisma.workspace.update({
            where: { id: workspace.id },
            data: {
              plan: data.plan ? (String(data.plan) as never) : undefined,
              isVerified:
                data.isVerified !== undefined ? Boolean(data.isVerified) : undefined,
            },
          });
        }
        return { id: workspace.id };
      },
    }),

    // MemberInWorkspace — Branch 2 (creation_function =
    // handleCreateWorkspaceInvitation).
    //
    // Two possible scenario intents for a standalone MemberInWorkspace node:
    //   (a) The ADMIN owner row that createUserWithDefaultWorkspace already
    //       minted inline when the parent User was created. The scenario is
    //       re-declaring it so other nodes can reference it by _alias.
    //       Re-calling handleCreateWorkspaceInvitation here is literally
    //       impossible — the function's existing-user branch requires the
    //       inviter be an ADMIN of the workspace, which is the same user,
    //       and it would hit "already a member" via the MemberInWorkspace
    //       unique constraint. So for this case the row already exists and
    //       the factory's job is to resolve it (no-op) and surface its
    //       composite key.
    //   (b) A MEMBER or GUEST member added for an existing User. This is
    //       the real `handleCreateWorkspaceInvitation` existing-user branch:
    //       the function calls prisma.memberInWorkspace.create + sends an
    //       email. We route through the real function for this case.
    //
    // We branch on "does the row already exist" to distinguish (a) from (b).
    MemberInWorkspace: defineFactory({
      create: async (data) => {
        const userId = String(data.userId);
        const workspaceId = String(data.workspaceId);
        const role = data.role ? (String(data.role) as never) : ("ADMIN" as never);

        // Case (a): already minted inline by the User factory — resolve and return.
        const existing = await prisma.memberInWorkspace.findUnique({
          where: { userId_workspaceId: { userId, workspaceId } },
        });
        if (existing) {
          return {
            id: `${userId}:${workspaceId}`,
            userId,
            workspaceId,
            preExisting: true,
          };
        }

        // Case (b): new member. Route through the real function so the
        // seat-limit / rate-limit / email side effects all run. Needs an
        // inviter (ADMIN of the workspace) + the invitee's email.
        const invitee = await prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        });
        if (!invitee?.email)
          throw new Error(
            `MemberInWorkspace factory: invitee User ${userId} has no email. The User factory must run before this.`,
          );
        const inviter = await findWorkspaceAdmin(workspaceId);
        try {
          await handleCreateWorkspaceInvitation({
            input: { workspaceId, email: invitee.email, type: role },
            context: { user: inviter },
          });
        } catch (error) {
          if (!isSmtpFailure(error)) throw error;
          // DB write happens before the email send — swallow SMTP failure
          // if the row landed.
        }
        const row = await prisma.memberInWorkspace.findUnique({
          where: { userId_workspaceId: { userId, workspaceId } },
        });
        if (!row)
          throw new Error(
            `MemberInWorkspace factory: row not written after handleCreateWorkspaceInvitation (userId ${userId}, workspaceId ${workspaceId}).`,
          );
        return {
          id: `${userId}:${workspaceId}`,
          userId,
          workspaceId,
        };
      },
      teardown: async (record) => {
        // Do not delete owner rows that the parent User factory created —
        // they will cascade when the User row is deleted. Only explicit
        // MEMBER/GUEST rows minted via handleCreateWorkspaceInvitation get
        // removed here (preExisting === false in the returned record).
        if (record.preExisting) return;
        await prisma.memberInWorkspace.deleteMany({
          where: {
            userId: String(record.userId),
            workspaceId: String(record.workspaceId),
          },
        });
      },
    }),

    // WorkspaceInvitation — Branch 2.
    // handleCreateWorkspaceInvitation splits on whether the invitee already
    // has a User row: existing-user branch creates a MemberInWorkspace,
    // new-user branch creates a WorkspaceInvitation. Scenarios only place
    // WorkspaceInvitation rows for emails that should NOT match a
    // pre-seeded User (enforced by {{pending_invite_email}} per
    // scenarios.md:63-68), so the real function always routes down the
    // invitation branch here. SMTP send is wrapped: without SMTP creds it
    // will throw, but the DB row is written BEFORE the send so the row is
    // already present — factory catches the send error and returns.
    WorkspaceInvitation: defineFactory({
      create: async (data, ctx) => {
        const workspaceId = String(data.workspaceId);
        const email = String(data.email);
        const type = data.type ? (String(data.type) as never) : ("MEMBER" as never);
        const inviter = await findWorkspaceAdmin(workspaceId);
        try {
          const result = await handleCreateWorkspaceInvitation({
            input: { workspaceId, email, type },
            context: { user: inviter },
          });
          if ("invitation" in result && result.invitation) {
            return { id: result.invitation.id };
          }
          // existingUser branch — function minted a MemberInWorkspace instead.
          throw new Error(
            `WorkspaceInvitation factory: an existing user with email ${email} was found; the real function created a MemberInWorkspace instead of an invitation. Scenarios must use an email that is not pre-seeded as a User.`,
          );
        } catch (error) {
          if (isSmtpFailure(error)) {
            // DB row landed before SMTP — fetch and return it.
            const row = await prisma.workspaceInvitation.findFirst({
              where: { workspaceId, email },
              orderBy: { createdAt: "desc" },
            });
            if (row) return { id: row.id };
          }
          throw error;
        }
      },
    }),

    // Invitation — Branch 2.
    // Same function (handleCreateInvitation) handles both
    // Invitation (new-user) and CollaboratorsOnTypebots (existing-user).
    // Scenarios use {{pending_invite_email}} for Invitation nodes, which by
    // definition does not match an existing User, so this path always
    // writes an Invitation row. Like WorkspaceInvitation, SMTP failure is
    // tolerated since the DB write precedes the mail send.
    Invitation: defineFactory({
      create: async (data, ctx) => {
        const typebotId = String(data.typebotId);
        const email = String(data.email);
        const type = data.type ? (String(data.type) as never) : ("READ" as never);
        const inviter = await findTypebotAdmin(typebotId);
        try {
          await handleCreateInvitation({
            input: { typebotId, email, type },
            context: { user: inviter },
          });
        } catch (error) {
          if (!isSmtpFailure(error)) throw error;
        }
        const normalizedEmail = email.toLowerCase().trim();
        const row = await prisma.invitation.findFirst({
          where: { typebotId, email: normalizedEmail },
          orderBy: { createdAt: "desc" },
        });
        if (!row)
          throw new Error(
            `Invitation factory: no Invitation row found after handleCreateInvitation (email ${email} may already belong to a User — the function wrote a CollaboratorsOnTypebots row instead).`,
          );
        // Invitation has no synthetic id column — composite PK is
        // [email, typebotId]. Return a synthetic id for SDK ref tracking.
        return {
          id: `${row.email}:${row.typebotId}`,
          email: row.email,
          typebotId: row.typebotId,
        };
      },
      teardown: async (record) => {
        await prisma.invitation.deleteMany({
          where: {
            email: String(record.email),
            typebotId: String(record.typebotId),
          },
        });
      },
    }),

    // CollaboratorsOnTypebots — Branch 2.
    // Same function as Invitation but scenarios node this only when the
    // target email IS an existing User (they pass userId _ref). We pass
    // the email of that user so handleCreateInvitation routes down the
    // existingUser branch and creates CollaboratorsOnTypebots +
    // upserts the GUEST MemberInWorkspace inline.
    CollaboratorsOnTypebots: defineFactory({
      create: async (data, ctx) => {
        const typebotId = String(data.typebotId);
        const userId = String(data.userId);
        const type = data.type ? (String(data.type) as never) : ("READ" as never);
        const collaborator = refLookup(ctx.refs, "User", userId);
        const collaboratorEmail = collaborator?.email ? String(collaborator.email) : null;
        if (!collaboratorEmail)
          throw new Error(
            `CollaboratorsOnTypebots factory: could not resolve email for userId ${userId}. The scenario must create the collaborator User first.`,
          );
        const inviter = await findTypebotAdmin(typebotId);
        try {
          await handleCreateInvitation({
            input: { typebotId, email: collaboratorEmail, type },
            context: { user: inviter },
          });
        } catch (error) {
          if (!isSmtpFailure(error)) throw error;
        }
        // CollaboratorsOnTypebots uses (userId, typebotId) as the composite PK/unique key.
        const row = await prisma.collaboratorsOnTypebots.findFirst({
          where: { typebotId, userId },
        });
        if (!row)
          throw new Error(
            `CollaboratorsOnTypebots factory: no row found after handleCreateInvitation for userId ${userId}, typebotId ${typebotId}.`,
          );
        // No synthetic id column in schema; surface composite key.
        return { id: `${row.userId}:${row.typebotId}`, userId: row.userId, typebotId: row.typebotId };
      },
      teardown: async (record) => {
        await prisma.collaboratorsOnTypebots.deleteMany({
          where: {
            userId: String(record.userId),
            typebotId: String(record.typebotId),
          },
        });
      },
    }),

    // Typebot — Branch 2.
    Typebot: defineFactory({
      create: async (data) => {
        const workspaceId = String(data.workspaceId);
        const admin = await findWorkspaceAdmin(workspaceId);
        const { typebot: rawInput, ...rest } = data as {
          typebot?: Record<string, unknown>;
        } & Record<string, unknown>;
        // Scenarios either pass a nested "typebot" input or flat top-level
        // fields that mirror the schema — build the input shape the real
        // handler expects (Partial<TypebotV6>).
        const typebotInput = rawInput ?? {
          name: rest.name,
          icon: rest.icon,
          folderId: rest.folderId,
          publicId: rest.publicId,
          customDomain: rest.customDomain,
          groups: rest.groups,
          events: rest.events,
          variables: rest.variables,
          edges: rest.edges,
          theme: rest.theme,
          settings: rest.settings,
          selectedThemeTemplateId: rest.selectedThemeTemplateId,
          resultsTablePreferences: rest.resultsTablePreferences,
        };
        const { typebot } = await handleCreateTypebot({
          input: {
            workspaceId,
            typebot: typebotInput as never,
          },
          context: { user: admin },
        });
        // Apply fields the create handler does not write directly
        // (isArchived, customDomain, riskLevel).
        const postUpdate: Record<string, unknown> = {};
        if (rest.isArchived !== undefined) postUpdate.isArchived = Boolean(rest.isArchived);
        if (rest.isClosed !== undefined) postUpdate.isClosed = Boolean(rest.isClosed);
        if (rest.riskLevel !== undefined)
          postUpdate.riskLevel = Number(rest.riskLevel);
        if (rest.customDomain !== undefined)
          postUpdate.customDomain = rest.customDomain as string | null;
        if (Object.keys(postUpdate).length > 0) {
          await prisma.typebot.update({
            where: { id: typebot.id },
            data: postUpdate,
          });
        }
        return { id: typebot.id };
      },
    }),

    // PublicTypebot — Branch 2.
    // handlePublishTypebot does an upsert-like shape on the parent Typebot:
    // it updateMany's an existing PublicTypebot or createMany's a new one.
    // We call it and then fetch the PublicTypebot row back (it has its own
    // auto-generated id that the real function does not return).
    PublicTypebot: defineFactory({
      create: async (data) => {
        const typebotId = String(data.typebotId);
        const typebot = await prisma.typebot.findUnique({
          where: { id: typebotId },
          select: { workspaceId: true },
        });
        if (!typebot)
          throw new Error(
            `PublicTypebot factory: parent Typebot ${typebotId} not found.`,
          );
        const admin = await findWorkspaceAdmin(typebot.workspaceId);
        try {
          await handlePublishTypebot({
            input: { typebotId },
            context: { user: admin },
          });
        } catch (error) {
          if (!isExternalSideEffectFailure(error)) throw error;
        }
        const row = await prisma.publicTypebot.findFirst({
          where: { typebotId },
          orderBy: { createdAt: "desc" },
        });
        if (!row)
          throw new Error(
            `PublicTypebot factory: no row found after handlePublishTypebot (typebotId ${typebotId}). If riskLevel > 80 the bot was removed — seed a verified workspace.`,
          );
        return { id: row.id };
      },
    }),

    // DashboardFolder — Branch 2.
    DashboardFolder: defineFactory({
      create: async (data) => {
        const workspaceId = String(data.workspaceId);
        const admin = await findWorkspaceAdmin(workspaceId);
        const { folder } = await handleCreateFolder({
          input: {
            workspaceId,
            folderName: data.name ? String(data.name) : undefined,
            parentFolderId: data.parentFolderId
              ? String(data.parentFolderId)
              : undefined,
            id: data.id ? String(data.id) : undefined,
          },
          context: { user: admin },
        });
        return { id: folder.id };
      },
    }),

    // CustomDomain — Branch 2.
    // The real handler calls the Vercel Projects API BEFORE writing to
    // Prisma. Without a VERCEL_TOKEN (or in a test env) the outbound
    // fetch throws, the handler wraps it in an ORPCError, and the Prisma
    // write never runs. We catch that specific external-side-effect
    // failure and fall through to an upsert that matches the handler's
    // one-line Prisma write — keeping the test scenario exercising the
    // same DB state the production path would land without the Vercel
    // side effect.
    CustomDomain: defineFactory({
      create: async (data) => {
        const workspaceId = String(data.workspaceId);
        const name = String(data.name);
        const admin = await findWorkspaceAdmin(workspaceId);
        try {
          const { customDomain } = await handleCreateCustomDomain({
            input: { workspaceId, name },
            context: { user: admin },
          });
          // CustomDomain's Prisma @id is `name` (not a synthetic `id`
          // column). The SDK validates the factory return against the
          // model's discovered pkFieldName, so we surface the name under
          // both keys for ref lookups + PK validation.
          return { id: customDomain.name, name: customDomain.name };
        } catch (error) {
          if (!isExternalSideEffectFailure(error)) throw error;
          const row = await fallbackPersistCustomDomain({ name, workspaceId });
          return { id: row.name, name: row.name };
        }
      },
      teardown: async (record) => {
        const pk = record.name ?? record.id;
        if (!pk) return;
        await prisma.customDomain.deleteMany({
          where: { name: String(pk) },
        });
      },
    }),

    // Credentials (workspace-scoped) — Branch 2.
    Credentials: defineFactory({
      create: async (data) => {
        const workspaceId = String(data.workspaceId);
        const admin = await findWorkspaceAdmin(workspaceId);
        const { credentialsId } = await handleCreateCredentials({
          input: {
            scope: "workspace",
            workspaceId,
            credentials: {
              name: String(data.name),
              type: (data.type ?? "stripe") as never,
              data: (data.data ?? {}) as never,
            } as never,
          },
          context: { user: admin },
        });
        return { id: credentialsId };
      },
    }),

    // UserCredentials (user-scoped) — Branch 2.
    UserCredentials: defineFactory({
      create: async (data) => {
        const userId = String(data.userId);
        const { credentialsId } = await handleCreateCredentials({
          input: {
            scope: "user",
            credentials: {
              name: String(data.name),
              type: (data.type ?? "openai") as never,
              data: (data.data ?? {}) as never,
            } as never,
          },
          context: { user: { id: userId } },
        });
        return { id: credentialsId };
      },
    }),

    // ApiToken — Branch 2.
    ApiToken: defineFactory({
      create: async (data) => {
        const userId = String(data.ownerId ?? data.userId);
        const { apiToken } = await handleCreateApiToken({
          input: { name: data.name ? String(data.name) : "Test Token" },
          context: { user: { id: userId } },
        });
        return { id: apiToken.id, token: apiToken.token };
      },
    }),

    // ThemeTemplate — Branch 2.
    ThemeTemplate: defineFactory({
      create: async (data) => {
        const workspaceId = String(data.workspaceId);
        const admin = await findWorkspaceAdmin(workspaceId);
        const { themeTemplate } = await handleSaveThemeTemplate({
          input: {
            workspaceId,
            themeTemplateId: data.id ? String(data.id) : createId(),
            name: String(data.name),
            theme: (data.theme ?? {}) as never,
          },
          context: { user: admin },
        });
        return { id: themeTemplate.id };
      },
    }),

    // Space — Branch 1 (extraction: packages/spaces/src/drivers/factory/
    // createSpaceForFactory.ts). The extracted helper provides the
    // PrismaLayer so we skip the feature-flag/user-access policy checks
    // but keep the repo's real Prisma write + unique-constraint mapping.
    Space: defineFactory({
      create: async (data) => {
        const input = Schema.decodeSync(SpaceCreateInputSchema)({
          workspaceId: String(data.workspaceId),
          name: String(data.name),
          icon: data.icon ? String(data.icon) : undefined,
        });
        const space = await createSpaceForFactory(input);
        return { id: space.id };
      },
    }),

    // SuppressedEmail — Branch 1 (extraction:
    // apps/builder/src/features/emails/api/suppressEmail.ts).
    SuppressedEmail: defineFactory({
      create: async (data) => {
        const row = await suppressEmail(String(data.email));
        if (!row) throw new Error("SuppressedEmail factory: invalid email");
        return { id: row.email };
      },
      teardown: async (record) => {
        await prisma.suppressedEmail.delete({ where: { email: String(record.id) } });
      },
    }),

    // VerificationToken — Branch 2 (NextAuth adapter method).
    VerificationToken: defineFactory({
      create: async (data) => {
        const adapter = createAuthPrismaAdapter(prisma);
        if (!adapter.createVerificationToken)
          throw new Error(
            "createAuthPrismaAdapter did not expose createVerificationToken.",
          );
        const token = await adapter.createVerificationToken({
          identifier: String(data.identifier),
          token: String(data.token),
          expires: data.expires ? new Date(String(data.expires)) : new Date(Date.now() + 3600_000),
        });
        if (!token) throw new Error("VerificationToken factory returned null.");
        // VerificationToken uses (identifier, token) as composite PK.
        return {
          id: `${token.identifier}:${token.token}`,
          identifier: token.identifier,
          token: token.token,
        };
      },
      teardown: async (record) => {
        await prisma.verificationToken.delete({
          where: {
            identifier_token: {
              identifier: String(record.identifier),
              token: String(record.token),
            },
          },
        });
      },
    }),

    // Account — Branch 2 (NextAuth adapter method).
    Account: defineFactory({
      create: async (data) => {
        const adapter = createAuthPrismaAdapter(prisma);
        if (!adapter.linkAccount)
          throw new Error("createAuthPrismaAdapter did not expose linkAccount.");
        const account = await adapter.linkAccount({
          userId: String(data.userId),
          type: (data.type ?? "oauth") as never,
          provider: String(data.provider),
          providerAccountId: String(data.providerAccountId),
          refresh_token: data.refresh_token ? String(data.refresh_token) : undefined,
          access_token: data.access_token ? String(data.access_token) : undefined,
          expires_at:
            data.expires_at !== undefined ? Number(data.expires_at) : undefined,
          token_type: data.token_type
            ? (String(data.token_type).toLowerCase() as Lowercase<string>)
            : undefined,
          scope: data.scope ? String(data.scope) : undefined,
          id_token: data.id_token ? String(data.id_token) : undefined,
          session_state: data.session_state ? String(data.session_state) : undefined,
        });
        const id = (account as { id?: string } | null | undefined)?.id;
        if (!id) {
          // linkAccount may return null — re-fetch.
          const row = await prisma.account.findUnique({
            where: {
              provider_providerAccountId: {
                provider: String(data.provider),
                providerAccountId: String(data.providerAccountId),
              },
            },
          });
          if (!row) throw new Error("Account factory: row not found after linkAccount.");
          return { id: row.id };
        }
        return { id };
      },
    }),

    // Session — Branch 2 (NextAuth adapter method).
    // Note: JWT session strategy is active at runtime (see nextAuth.ts)
    // so this table is not written during signin in production. Factory
    // still exists for completeness per the audit.
    Session: defineFactory({
      create: async (data) => {
        const adapter = createAuthPrismaAdapter(prisma);
        if (!adapter.createSession)
          throw new Error("createAuthPrismaAdapter did not expose createSession.");
        const session = await adapter.createSession({
          sessionToken: String(data.sessionToken),
          userId: String(data.userId),
          expires: data.expires ? new Date(String(data.expires)) : new Date(Date.now() + 86400_000),
        });
        const id = (session as { id?: string } | null | undefined)?.id;
        if (!id)
          throw new Error("Session factory: adapter.createSession did not return id.");
        return { id };
      },
    }),

    // Result — Branch 2.
    Result: defineFactory({
      create: async (data) => {
        const typebotId = String(data.typebotId);
        const typebot = await prisma.typebot.findUnique({
          where: { id: typebotId },
          select: {
            id: true,
            variables: true,
            version: true,
          },
        });
        if (!typebot)
          throw new Error(`Result factory: Typebot ${typebotId} not found.`);
        const resultId = data.id ? String(data.id) : createId();
        await upsertResult({
          resultId,
          typebot: {
            id: typebot.id,
            variables: (Array.isArray(typebot.variables)
              ? (typebot.variables as unknown[])
              : []) as never,
            version: typebot.version as never,
          } as never,
          hasStarted: Boolean(data.hasStarted ?? true),
          isCompleted: Boolean(data.isCompleted ?? false),
        });
        return { id: resultId };
      },
    }),

    // AnswerV2 — Branch 2.
    AnswerV2: defineFactory({
      create: async (data) => {
        const resultId = String(data.resultId);
        await saveAnswer({
          answer: {
            blockId: String(data.blockId),
            content: String(data.content ?? ""),
            attachedFileUrls: (data.attachedFileUrls ?? undefined) as never,
          } as never,
          state: {
            typebotsQueue: [
              { resultId, typebot: { id: "placeholder" } as never } as never,
            ],
          } as never,
        });
        // createMany doesn't return rows; fetch the row we just wrote.
        const row = await prisma.answerV2.findFirst({
          where: { resultId, blockId: String(data.blockId) },
          orderBy: { createdAt: "desc" },
        });
        if (!row)
          throw new Error(
            `AnswerV2 factory: row not found after saveAnswer (resultId ${resultId}).`,
          );
        return { id: row.id };
      },
    }),

    // Log — Branch 2.
    Log: defineFactory({
      create: async (data) => {
        const resultId = String(data.resultId);
        const status = data.status
          ? (String(data.status) as "error" | "success" | "info")
          : "info";
        const row = await saveLog({
          status,
          resultId,
          message: String(data.description ?? data.message ?? ""),
          details: data.details,
        });
        if (!row)
          throw new Error(
            `Log factory: saveLog returned null (resultId ${resultId} may be invalid).`,
          );
        return { id: row.id };
      },
    }),

    // VisitedEdge — Branch 2.
    // saveVisitedEdges uses createMany and returns BatchPayload; the table
    // has a composite PK (resultId, edgeId, index) with no synthetic id.
    // Factory writes via the real helper then fetches the row back to
    // return its composite key for teardown.
    VisitedEdge: defineFactory({
      create: async (data) => {
        const resultId = String(data.resultId);
        const edgeId = String(data.edgeId);
        const index = Number(data.index ?? 0);
        await saveVisitedEdges([{ resultId, edgeId, index } as never]);
        return {
          id: `${resultId}:${index}`,
          resultId,
          edgeId,
          index,
        };
      },
      teardown: async (record) => {
        // VisitedEdge composite unique is [resultId, index]; schema has no id.
        await prisma.visitedEdge.deleteMany({
          where: {
            resultId: String(record.resultId),
            index: Number(record.index),
          },
        });
      },
    }),

    // SetVariableHistoryItem — Branch 2.
    SetVariableHistoryItem: defineFactory({
      create: async (data) => {
        const resultId = String(data.resultId);
        const blockId = String(data.blockId);
        const variableId = String(data.variableId);
        const index = Number(data.index ?? 0);
        await saveSetVariableHistoryItemsForFactory([
          {
            resultId,
            blockId,
            variableId,
            index,
            value: data.value ?? null,
          } as never,
        ]);
        return {
          id: `${resultId}:${blockId}:${index}`,
          resultId,
          blockId,
          index,
        };
      },
      teardown: async (record) => {
        // SetVariableHistoryItem composite unique is [resultId, index]; no id.
        await prisma.setVariableHistoryItem.deleteMany({
          where: {
            resultId: String(record.resultId),
            index: Number(record.index),
          },
        });
      },
    }),

    // ChatSession — Branch 2.
    // Not FK-linked to any other row (Result references via string
    // lastChatSessionId). Must register explicit teardown.
    ChatSession: defineFactory({
      create: async (data) => {
        const id = data.id ? String(data.id) : createId();
        const row = await upsertSession(id, {
          state: (data.state ?? {}) as never,
        });
        return { id: row.id };
      },
      teardown: async (record) => {
        await prisma.chatSession.delete({ where: { id: String(record.id) } });
      },
    }),

    // RuntimeMediaIdCache — Branch 2.
    // The model has no scalar primary key; the table is keyed on the
    // composite @@unique([publicTypebotId, provider, url]). Factories must
    // still return a stable string id for the SDK refs map, so we
    // synthesise one from the composite tuple.
    RuntimeMediaIdCache: defineFactory({
      create: async (data) => {
        const row = await insertMediaIdToCache({
          url: String(data.url),
          mediaId: String(data.mediaId),
          provider: (data.provider ?? "whatsapp") as never,
          publicTypebotId: String(data.publicTypebotId),
          expiresAt: data.expiresAt ? new Date(String(data.expiresAt)) : undefined,
        });
        return {
          id: `${row.publicTypebotId}:${row.provider}:${row.url}`,
        };
      },
    }),

    // Coupon — Branch 1 (new helper: packages/prisma/src/admin/createCoupon.ts).
    // Coupon has no in-application creation path; the extracted helper is
    // a thin wrapper that represents the admin-tooling path.
    Coupon: defineFactory({
      create: async (data) => {
        const row = await createCoupon({
          code: String(data.code),
          userPropertiesToUpdate: (data.userPropertiesToUpdate ?? {}) as never,
          dateRedeemed: data.dateRedeemed ? new Date(String(data.dateRedeemed)) : null,
        });
        // Coupon's Prisma @id is `code` — the SDK validates the
        // factory's returned record against the discovered pkFieldName,
        // so we surface the code under both keys for ref lookups + PK
        // validation.
        return { id: row.code, code: row.code };
      },
      teardown: async (record) => {
        const pk = record.code ?? record.id;
        if (!pk) return;
        await prisma.coupon.deleteMany({ where: { code: String(pk) } });
      },
    }),
  },

  // Auth callback. Typebot runs NextAuth with `session.strategy = "jwt"`
  // (see packages/auth/src/lib/nextAuth.ts:31). We return TWO things:
  //
  //   1. `credentials` with email + the known test password so Autonoma
  //      can drive the real NextAuth Credentials provider login flow.
  //      This is the most robust path — it exercises the actual signin.
  //
  //   2. A pre-minted NextAuth JWT cookie (`authjs.session-token` or
  //      `__Secure-authjs.session-token` depending on host) for tests
  //      that need an already-authenticated session without clicking
  //      through the signin page. The JWT is encoded with AUTH_SECRET /
  //      ENCRYPTION_SECRET — exactly what nextAuth.ts uses — so the
  //      middleware treats it as a normal session.
  auth: async (user) => {
    if (!user || !user.id || !user.email) {
      return {};
    }
    const userId = String(user.id);
    const email = String(user.email);
    const nextAuthSecret =
      process.env.AUTH_SECRET ??
      process.env.NEXTAUTH_SECRET ??
      env.ENCRYPTION_SECRET;
    // Mirror the session payload nextAuth.ts sets in the `jwt` callback.
    const dbUser = await prisma.user.findUnique({ where: { id: userId } });
    const tokenValue = await encodeNextAuthJwt({
      token: {
        sub: userId,
        email,
        name: dbUser?.name ?? null,
        picture: dbUser?.image ?? null,
        user: dbUser
          ? {
              id: dbUser.id,
              email: dbUser.email,
              name: dbUser.name,
              image: dbUser.image,
              createdAt: dbUser.createdAt,
            }
          : undefined,
        lastActivityAt: (dbUser?.lastActivityAt ?? new Date()).toISOString(),
      } as never,
      secret: nextAuthSecret,
      salt: "authjs.session-token",
      maxAge: 60 * 60 * 24, // 1 day
    });
    return {
      cookies: [
        {
          name: "authjs.session-token",
          value: tokenValue,
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24,
        },
      ],
      credentials: {
        email,
        password: DEFAULT_TEST_PASSWORD,
      },
    };
  },
});

// --- helpers ---------------------------------------------------------------

// Many of the handle* functions require a `context.user` — an ADMIN of the
// workspace. Factories run after the User factory, so we can fetch any
// ADMIN membership from the DB and use that user as the caller. This
// avoids threading the caller user id through the scenario tree.
async function findWorkspaceAdmin(workspaceId: string) {
  const member = await prisma.memberInWorkspace.findFirst({
    where: { workspaceId, role: "ADMIN" },
    select: { userId: true, user: { select: { id: true, email: true } } },
  });
  if (!member?.user)
    throw new Error(
      `No ADMIN member found for workspace ${workspaceId}. Ensure the User factory ran first.`,
    );
  return { id: member.user.id, email: member.user.email ?? "" };
}

async function findTypebotAdmin(typebotId: string) {
  const typebot = await prisma.typebot.findUnique({
    where: { id: typebotId },
    select: { workspaceId: true },
  });
  if (!typebot)
    throw new Error(`findTypebotAdmin: typebot ${typebotId} not found.`);
  return findWorkspaceAdmin(typebot.workspaceId);
}

function isSmtpFailure(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /SMTP|ETIMEDOUT|ECONNREFUSED|EAUTH|sendMail|getaddrinfo|transporter|Nodemailer/i.test(
      message,
    ) ||
    (typeof (error as { code?: unknown }).code === "string" &&
      /SMTP|ECONNREFUSED|ETIMEDOUT|EAUTH|ENOTFOUND/.test(
        String((error as { code?: string }).code),
      ))
  );
}

function isExternalSideEffectFailure(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Vercel|ky|fetch failed|ENOTFOUND|ECONNREFUSED|Discord|Slack|posthog|webhook|FORBIDDEN/i.test(
      message,
    ) || isSmtpFailure(error)
  );
}

