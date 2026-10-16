export type SecretReadiness = { readonly configured: true } | { readonly configured: false; readonly reason: "MISSING_OR_BLANK" };
export function checkSecretReadiness(secret: string | undefined | null): SecretReadiness {
  if (typeof secret !== "string" || secret.trim().length === 0) return { configured: false, reason: "MISSING_OR_BLANK" };
  return { configured: true };
}
export function requireSecret(secret: string | undefined | null, name: string): string {
  if (!checkSecretReadiness(secret).configured) throw new Error(`Required secret is not configured: ${name}`);
  return secret as string;
}
