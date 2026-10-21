import { auth } from "@/lib/auth";
import { redactError } from "@/lib/bing/redact-url";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { isBingEnabled } from "@/lib/flags";

// Single-key providers. The key is stored in `encryptedPassword`.
// DataForSEO was removed (EUR-407). Bing is hidden unless BING_ENABLED=true.
const SUPPORTED_PROVIDERS = ["google_pagespeed", "bing"] as const;
type Provider = (typeof SUPPORTED_PROVIDERS)[number];

function isSupportedProvider(value: unknown): value is Provider {
  if (value === "bing" && !isBingEnabled()) return false;
  return typeof value === "string" && SUPPORTED_PROVIDERS.includes(value as Provider);
}

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const keys = await db.apiKey.findMany({
      where: { userId: session.user.id },
      select: { provider: true, createdAt: true, updatedAt: true },
    });

    const visible = SUPPORTED_PROVIDERS.filter((provider) => isSupportedProvider(provider));
    const providers: Record<string, { connected: boolean; updatedAt?: string }> =
      Object.fromEntries(visible.map((provider) => [provider, { connected: false }]));

    for (const key of keys) {
      if (!isSupportedProvider(key.provider)) continue;
      providers[key.provider] = {
        connected: true,
        updatedAt: key.updatedAt.toISOString(),
      };
    }

    return Response.json(providers);
  } catch (error) {
    console.error("API keys GET error:", redactError(error));
    return Response.json({ error: "Failed to load API keys" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: { provider?: string; login?: string; password?: string; apiKey?: string } | undefined;
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    body = (await req.json()) as {
      provider?: string;
      login?: string;
      password?: string;
      apiKey?: string;
    };

    if (body.provider === "dataforseo" || (body.provider === "bing" && !isBingEnabled())) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (!isSupportedProvider(body.provider)) {
      return Response.json({ error: "Unsupported provider" }, { status: 400 });
    }

    if (!body.apiKey) {
      return Response.json(
        { error: "Missing required field: apiKey" },
        { status: 400 }
      );
    }
    const encryptedLogin: string | null = null;
    const encryptedPassword = encrypt(body.apiKey);

    const saved = await db.apiKey.upsert({
      where: {
        userId_provider: {
          userId: session.user.id,
          provider: body.provider,
        },
      },
      create: {
        userId: session.user.id,
        provider: body.provider,
        encryptedLogin,
        encryptedPassword,
      },
      update: {
        encryptedLogin,
        encryptedPassword,
      },
    });

    return Response.json(
      { provider: saved.provider, connected: true },
      { status: 201 }
    );
  } catch (error) {
    console.error("API keys POST error:", redactError(error, body?.apiKey));
    return Response.json({ error: "Failed to save API key" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as { provider?: string };
    if (body.provider === "dataforseo" || (body.provider === "bing" && !isBingEnabled())) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (!isSupportedProvider(body.provider)) {
      return Response.json({ error: "Unsupported provider" }, { status: 400 });
    }

    const userId = session.user.id;
    const deleteKey = db.apiKey.delete({
      where: { userId_provider: { userId, provider: body.provider } },
    });
    if (body.provider === "bing") {
      // Without a key no property can sync, and a key from another account
      // will not see these properties: disconnect them with the key. The
      // Site update goes first so its row locks wait for a sync in flight
      // (bing-sync.ts holds the Site row while it writes) and the wipe sees
      // the rows that sync committed.
      await db.$transaction([
        db.site.updateMany({
          where: { userId, bingSite: { not: null } },
          data: { bingSite: null },
        }),
        db.bingSearchWeekly.deleteMany({ where: { site: { userId } } }),
        db.bingDaily.deleteMany({ where: { site: { userId } } }),
        deleteKey,
      ]);
    } else {
      await deleteKey;
    }

    return Response.json({ success: true });
  } catch (error) {
    console.error("API keys DELETE error:", redactError(error));
    return Response.json({ error: "Failed to delete API key" }, { status: 500 });
  }
}
