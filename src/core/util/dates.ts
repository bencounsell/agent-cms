export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string" && value.trim()) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

export function daysSince(iso: string | undefined, now = new Date()): number | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}

export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}
