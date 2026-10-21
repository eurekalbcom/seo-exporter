import { auth } from "@/lib/auth";
import { testBingKey } from "@/lib/bing";
import { redactError } from "@/lib/bing/redact-url";
import { isBingEnabled } from "@/lib/flags";

export async function POST(req: Request) {
  let body: { provider?: string; apiKey?: string } | undefined;
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    body = (await req.json()) as {
      provider?: string;
      apiKey?: string;
    };
    const provider = body.provider;

    if (provider === "dataforseo" || (provider === "bing" && !isBingEnabled())) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    if (provider !== "bing") {
      return Response.json({ error: "Unsupported provider" }, { status: 400 });
    }

    if (!body.apiKey) {
      return Response.json({ error: "Missing API key" }, { status: 400 });
    }
    return Response.json({ success: await testBingKey(body.apiKey) });
  } catch (error) {
    console.error("API key test error:", redactError(error, body?.apiKey));
    return Response.json({ error: "Connection test failed" }, { status: 500 });
  }
}
