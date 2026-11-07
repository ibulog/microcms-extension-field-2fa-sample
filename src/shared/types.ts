export type MfaResult =
  | { status: 'enabled' | 'disabled'; checkedAt: string }
  | { status: 'unknown' };

export type MemberLookup = (email: string, forceRefresh?: boolean) => Promise<MfaResult>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isKnownMfaResult(value: unknown): value is Extract<MfaResult, { checkedAt: string }> {
  return isRecord(value) && (value.status === 'enabled' || value.status === 'disabled') &&
    typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt));
}
