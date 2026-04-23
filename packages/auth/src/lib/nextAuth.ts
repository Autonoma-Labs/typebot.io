import { env } from "@typebot.io/env";
import { datesAreOnSameDay } from "@typebot.io/lib/datesAreOnSameDay";
import { getIp } from "@typebot.io/lib/getIp";
import { isDefined } from "@typebot.io/lib/utils";
import prisma from "@typebot.io/prisma";
import {
  getTypebotCookie,
  serializeTypebotCookie,
} from "@typebot.io/telemetry/cookies/helpers";
import type { TypebotCookieValue } from "@typebot.io/telemetry/cookies/schema";
import { mergeIds } from "@typebot.io/telemetry/mergeIds";
import { trackEvents } from "@typebot.io/telemetry/trackEvents";
import { clientUserSchema } from "@typebot.io/user/schemas";
import type { NextRequest } from "next/server";
import NextAuth, { type NextAuthResult } from "next-auth";
import { accountHasRequiredOAuthGroups } from "../helpers/accountHasRequiredOAuthGroups";
import { createAuthPrismaAdapter } from "../helpers/createAuthPrismaAdapter";
import { isEmailLegit } from "../helpers/emailValidation";
import { getNewUserInvitations } from "../helpers/getNewUserInvitations";
import oneMinRateLimiter from "./oneMinRateLimiter";
import { providers } from "./providers";

export const SET_TYPEBOT_COOKIE_HEADER = "Set-Typebot-Cookie" as const;

const nextAuth = NextAuth((req) => {
  return {
    adapter: createAuthPrismaAdapter(prisma),
    secret: env.ENCRYPTION_SECRET,
    providers,
    // JWT strategy so Credentials provider works alongside the adapter
    session: { strategy: "jwt" },
    trustHost: true,
    debug: true,
    pages: {
      signIn: "/signin",
      newUser: env.NEXT_PUBLIC_ONBOARDING_TYPEBOT_ID ? "/onboarding" : undefined,
      error: "/signin",
    },
    events: {
      session: async ({ session, token }) => {
        if (!token?.sub) return;
        const lastActivityAt = token.lastActivityAt as string | undefined;
        const lastDate = lastActivityAt ? new Date(lastActivityAt) : new Date(0);
        if (!datesAreOnSameDay(lastDate, new Date())) {
          await prisma.user.updateMany({
            where: { id: token.sub },
            data: { lastActivityAt: new Date() },
          });
          token.lastActivityAt = new Date().toISOString();
        }
        const typebotCookie = getTypebotCookieFromNextReq(req);
        if (typebotCookie) {
          if (
            typebotCookie?.landingPage?.id &&
            !typebotCookie.landingPage.isMerged
          ) {
            await mergeIds({
              visitorId: typebotCookie.landingPage.id,
              userId: token.sub,
            });
            updateCookieIsMerged({ req, typebotCookie });
          }
        }
      },
      async signIn({ user, isNewUser, account }) {
        if (!user.id) return;
        const typebotCookie = getTypebotCookieFromNextReq(req);
        if (typebotCookie && account?.provider)
          updateCookieLastProvider(account.provider, { req, typebotCookie });
        if (isNewUser) return;
        await trackEvents([
          {
            name: "User logged in",
            userId: user.id,
          },
        ]);
      },
      async signOut(props) {
        const typebotCookie = getTypebotCookieFromNextReq(req);
        if (typebotCookie) resetLandingPageCookie({ req, typebotCookie });
        // With JWT strategy, signOut receives { token }; with database it's { session }
        const userId =
          "token" in props
            ? (props.token?.sub as string | undefined)
            : (props as unknown as { session: { userId: string } }).session?.userId;
        if (userId) {
          await trackEvents([{ name: "User logged out", userId }]);
        }
      },
    },
    callbacks: {
      jwt: async ({ token, user, account }) => {
        // On first sign-in, user object is available — store full user data in token
        if (user?.id) {
          const dbUser = await prisma.user.findUnique({
            where: { id: user.id },
          });
          if (dbUser) {
            token.sub = dbUser.id;
            token.user = clientUserSchema.parse(dbUser);
            token.lastActivityAt = dbUser.lastActivityAt.toISOString();
          }
        }
        return token;
      },
      session: async ({ session, token }) => {
        if (token?.user) {
          return {
            ...session,
            user: token.user as ReturnType<typeof clientUserSchema.parse>,
          };
        }
        return session;
      },
      signIn: async ({ account, user, email }) => {
        // Credentials provider passes no account — allow if user exists
        if (!account) return !!user?.id;
        const isNewUser = !("createdAt" in user && isDefined(user.createdAt));
        if (user.email && email?.verificationRequest) {
          const ip = req
            ? getIp({
                "x-forwarded-for": req.headers.get("x-forwarded-for"),
                "cf-connecting-ip": req.headers.get("cf-connecting-ip"),
              })
            : null;
          if (oneMinRateLimiter && ip) {
            const { success } = await oneMinRateLimiter.limit(ip);
            if (!success) throw new Error("too-many-requests");
          }
          if (!isEmailLegit(user.email)) throw new Error("email-not-legit");
        }
        if (
          env.DISABLE_SIGNUP &&
          isNewUser &&
          user.email &&
          !env.ADMIN_EMAIL?.includes(user.email)
        ) {
          const { invitations, workspaceInvitations } =
            await getNewUserInvitations(prisma, user.email);
          if (invitations.length === 0 && workspaceInvitations.length === 0)
            throw new Error("sign-up-disabled");
        }
        return await accountHasRequiredOAuthGroups(account);
      },
    },
  };
});

const updateCookieIsMerged = ({
  req,
  typebotCookie,
}: {
  req: NextRequest | undefined;
  typebotCookie: TypebotCookieValue;
}) => {
  if (!isValidNextRequest(req) || !typebotCookie.landingPage) return;
  req.headers.set(
    SET_TYPEBOT_COOKIE_HEADER,
    serializeTypebotCookie({
      ...typebotCookie,
      landingPage: {
        ...typebotCookie.landingPage,
        isMerged: true,
      },
    }),
  );
};

const updateCookieLastProvider = (
  provider: string,
  {
    req,
    typebotCookie,
  }: { req: NextRequest | undefined; typebotCookie: TypebotCookieValue },
) => {
  if (!isValidNextRequest(req)) return;
  req.headers.set(
    SET_TYPEBOT_COOKIE_HEADER,
    serializeTypebotCookie({
      ...typebotCookie,
      lastProvider: provider,
    }),
  );
};

const resetLandingPageCookie = ({
  req,
  typebotCookie,
}: {
  req: NextRequest | undefined;
  typebotCookie: TypebotCookieValue;
}) => {
  if (!isValidNextRequest(req)) return;
  req.headers.set(
    SET_TYPEBOT_COOKIE_HEADER,
    serializeTypebotCookie({
      ...typebotCookie,
      lastProvider: undefined,
      landingPage: undefined,
    }),
  );
};

const getTypebotCookieFromNextReq = (
  req: NextRequest | undefined,
): TypebotCookieValue | null => {
  if (!isValidNextRequest(req)) return null;
  const cookieStr = req.headers.get("cookie");
  if (!cookieStr) return null;
  return getTypebotCookie(cookieStr);
};

// Nextauth req type is not correct, so we need to assert it
const isValidNextRequest = (
  req: NextRequest | undefined,
): req is NextRequest => {
  return Boolean(req && "headers" in req && "get" in req.headers);
};

export const authHandlers = nextAuth.handlers;
export const auth: NextAuthResult["auth"] = nextAuth.auth;
export const signIn = nextAuth.signIn;
export const signOut = nextAuth.signOut;
