/** Reads required environment configuration (set by the CDK stack). */
export function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`Environment variable ${name} must be a whole number, got "${v}"`);
  return n;
}

export function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}
