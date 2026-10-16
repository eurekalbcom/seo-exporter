export const TIME_ZONE = "Europe/Warsaw";

export const SCHEDULE = [
  { job: "gsc-sync", hour: 3, minute: 0 },
  { job: "crawl", hour: 4, minute: 0 },
  { job: "vitals", hour: 5, minute: 0 },
  { job: "analysis", hour: 6, minute: 0 },
] as const;

export type JobName = (typeof SCHEDULE)[number]["job"];

export function warsawClock(date: Date): { hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  return { hour: hour === 24 ? 0 : hour, minute };
}

export function jobAt(date: Date): JobName | null {
  const clock = warsawClock(date);
  const hit = SCHEDULE.find((row) => row.hour === clock.hour && row.minute === clock.minute);
  return hit?.job ?? null;
}
