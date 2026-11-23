/** Helpers that keep customer personal data (email addresses) out of logs. */

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function redactEmails(text: string): string {
  return text.replace(EMAIL, '[email]');
}

/** A log-safe summary of an error: its name and code plus message and stack with addresses removed. */
export function safeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { message: redactEmails(String(err)) };
  const code = (err as { code?: unknown; Code?: unknown }).code ?? (err as { Code?: unknown }).Code;
  return {
    name: err.name,
    ...(code !== undefined ? { code: String(code) } : {}),
    message: redactEmails(err.message),
    ...(err.stack ? { stack: redactEmails(err.stack) } : {}),
  };
}
