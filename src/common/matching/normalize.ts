/**
 * Normalizes a merchant/company name for matching (BRD section 18.2):
 * uppercase, strip punctuation, collapse whitespace, standardize PT/CV prefixes.
 */
export function normalizeName(raw: string): string {
  if (!raw) return '';
  let value = raw.toUpperCase().trim();
  value = value.replace(/[.,'"`]/g, '');
  value = value.replace(/^PT\s+/, 'PT ');
  value = value.replace(/^CV\s+/, 'CV ');
  value = value.replace(/\s+/g, ' ');
  return value.trim();
}
