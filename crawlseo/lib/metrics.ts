export const METRIC_NAMES = [
  "seo_clicks",
  "seo_impressions",
  "seo_position",
  "seo_crawl_issues",
  "seo_cwv",
  "seo_recommendations",
] as const;

export type MetricName = (typeof METRIC_NAMES)[number];

export type MetricSample = {
  name: MetricName;
  labels: Record<string, string>;
  value: number;
};

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const parts = Object.entries(labels).map(([key, value]) => `${key}="${escapeLabel(value)}"`);
  return `{${parts.join(",")}}`;
}

/** Prometheus text exposition. Every sample carries domain and category. */
export function renderPrometheus(samples: MetricSample[]): string {
  const lines: string[] = [];
  for (const name of METRIC_NAMES) {
    lines.push(`# TYPE ${name} gauge`);
  }
  for (const sample of samples) {
    if (!sample.labels.domain || !sample.labels.category) {
      throw new Error(`${sample.name} requires domain and category labels`);
    }
    if (!Number.isFinite(sample.value)) continue;
    lines.push(`${sample.name}${formatLabels(sample.labels)} ${sample.value}`);
  }
  return `${lines.join("\n")}\n`;
}
