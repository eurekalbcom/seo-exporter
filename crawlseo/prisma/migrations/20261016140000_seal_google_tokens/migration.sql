-- Google OAuth tokens are sealed by the application on startup
-- (lib/google/token-seal.ts), because AES-GCM needs NEXTAUTH_SECRET and
-- cannot run inside SQL. User.googleTokens is rewritten to
-- {"enc":"v1","data":"..."} and Account.access_token / refresh_token gain
-- the enc:v1: prefix. This migration records that change; the row rewrite
-- runs from instrumentation.ts.
SELECT 1;
