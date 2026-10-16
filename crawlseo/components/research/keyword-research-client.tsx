"use client";

import { useState } from "react";
import {
  Search,
  Loader2,
  Bookmark,
  Check,
} from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { UntrustedText } from "@/components/ui/untrusted-text";

type KeywordResult = {
  keyword: string;
  volume: number | null;
  difficulty: number | null;
  cpc: number | null;
  competition: number | null;
  trend: number[] | null;
};

export function KeywordResearchClient({
  siteId,
  autocompleteEnabled,
}: {
  siteId: string;
  autocompleteEnabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<KeywordResult[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [savedSet, setSavedSet] = useState<Set<string>>(new Set());
  const [savingSet, setSavingSet] = useState<Set<string>>(new Set());

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setResults([]);
    setSource(null);

    try {
      const res = await fetch(
        `/api/sites/${siteId}/keyword-research?q=${encodeURIComponent(query.trim())}`
      );
      const data = await res.json();
      setResults(data.keywords ?? []);
      setSource(data.source ?? null);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(keyword: string) {
    setSavingSet((prev) => new Set(prev).add(keyword));

    try {
      const res = await fetch(`/api/sites/${siteId}/saved-keywords`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: keyword }),
      });
      if (res.ok) {
        setSavedSet((prev) => new Set(prev).add(keyword));
      }
    } catch {
      // ignore
    } finally {
      setSavingSet((prev) => {
        const next = new Set(prev);
        next.delete(keyword);
        return next;
      });
    }
  }

  if (!autocompleteEnabled) {
    return (
      <p className="text-sm text-muted-foreground">
        Google Autocomplete is disabled.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* Search input */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Enter a seed keyword..."
            className="w-full rounded-lg border border-border bg-background py-2.5 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-brand-500 focus:bg-bg focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={!query.trim() || loading}
          className={buttonVariants()}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Search className="size-4" />
          )}
          Research
        </button>
      </form>

      {/* Results */}
      {results.length > 0 && (
        <div className="panel overflow-hidden">
          {source === "autocomplete" && (
            <div className="border-b border-border bg-bg-soft px-4 py-2 text-xs text-muted-foreground">
              Suggestions are untrusted third-party text, shown as data only.
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-4 py-3 font-medium text-muted-foreground">
                    Keyword
                  </th>
                  <th className="px-4 py-3 text-right font-medium text-muted-foreground">
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {results.map((result) => {
                  const isSaved = savedSet.has(result.keyword);
                  const isSaving = savingSet.has(result.keyword);

                  return (
                    <tr
                      key={result.keyword}
                      className="border-b border-border transition-colors hover:bg-bg-soft"
                    >
                      <td className="max-w-md px-4 py-3">
                        <span className="font-medium text-text-strong">
                          <UntrustedText value={result.keyword} />
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => handleSave(result.keyword)}
                          disabled={isSaved || isSaving}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-50"
                        >
                          {isSaved ? (
                            <>
                              <Check className="size-3 text-success" />
                              Saved
                            </>
                          ) : isSaving ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <>
                              <Bookmark className="size-3" />
                              Save
                            </>
                          )}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-border bg-bg-soft px-4 py-2 text-xs text-muted-foreground">
            {results.length} keyword{results.length !== 1 ? "s" : ""} found via Google Autocomplete
          </div>
        </div>
      )}

      {/* Empty state after search */}
      {!loading && results.length === 0 && source !== null && (
        <div className="panel flex flex-col items-center py-12 text-center">
          <Search className="size-10 text-text-faint" />
          <p className="mt-3 font-medium text-text-strong">No results found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Try a different seed keyword
          </p>
        </div>
      )}
    </div>
  );
}
