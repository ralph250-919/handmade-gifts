/** Reads required environment configuration (set by the CDK stack). */
export function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : fallback;
}

export function envList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}
