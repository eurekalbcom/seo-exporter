import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "./safe-http";

export type FixtureRoute = {
  status?: number;
  file?: string;
  body?: string;
  contentType?: string;
  location?: string;
};

export type FixtureManifest = {
  origin: string;
  routes: Record<string, FixtureRoute>;
};

export type FixtureSite = {
  origin: string;
  fetchImpl: FetchLike;
  calls: Array<{ url: string; method: string }>;
};

export function loadFixtureSite(dir: string): FixtureSite {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as FixtureManifest;
  const calls: FixtureSite["calls"] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
    const route = manifest.routes[new URL(url).pathname];
    if (!route) {
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    const headers = new Headers();
    if (route.contentType) headers.set("content-type", route.contentType);
    if (route.location) headers.set("location", route.location);
    const body = route.file ? readFileSync(join(dir, route.file)) : (route.body ?? "");
    const status = route.status ?? 200;
    return new Response(status >= 300 && status < 400 ? null : body, { status, headers });
  };
  return { origin: manifest.origin, fetchImpl, calls };
}
