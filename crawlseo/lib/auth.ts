import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "./db";
import { GOOGLE_OAUTH_SCOPE } from "./google/oauth-scope";
import { isSignInAllowed } from "./registration";

// Skipped during `next build` so the Docker image can be built without real
// credentials.  NEXT_PHASE is set by Next.js; SKIP_ENV_VALIDATION is a manual
// escape hatch for other build toolchains.
const isBuild =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.SKIP_ENV_VALIDATION === "1";
if (!isBuild && (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)) {
  throw new Error("Missing Google OAuth credentials");
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: GOOGLE_OAUTH_SCOPE,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    signIn({ account, user, profile }) {
      const profileEmail =
        profile && "email" in profile && typeof profile.email === "string" ? profile.email : null;
      return isSignInAllowed({
        account,
        email: user.email ?? profileEmail,
      });
    },
    async session({ session, user }) {
      if (session.user) {
        session.user.id = user.id;
      }
      return session;
    },
  },
  events: {
    async signIn({ user, account }) {
      if (account?.access_token && user?.email) {
        // Save Google OAuth tokens after user is created by adapter
        try {
          await db.user.update({
            where: { email: user.email },
            data: {
              googleTokens: {
                accessToken: account.access_token,
                refreshToken: account.refresh_token,
                // account.expires_at is Unix seconds; store ms to match
                // refreshAccessToken() and getAccessToken()'s Date.now() checks.
                expiresAt: account.expires_at
                  ? account.expires_at * 1000
                  : undefined,
                tokenType: account.token_type,
                scope: account.scope,
              },
            },
          });
        } catch (error) {
          console.error("Failed to save Google tokens:", error);
        }
      }
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
  session: {
    strategy: "database",
  },
  // Auth.js trusts X-Forwarded-Host only when this is exactly true. The
  // compose port is bound to 127.0.0.1, so leave AUTH_TRUST_HOST unset unless
  // a reverse proxy in front of that bind overwrites Host and X-Forwarded-Host.
  // A client who can reach the app can otherwise choose the OAuth callback host.
  trustHost: process.env.AUTH_TRUST_HOST?.trim().toLowerCase() === "true",
  secret: process.env.NEXTAUTH_SECRET,
});
