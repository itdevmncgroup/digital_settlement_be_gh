/** Case-insensitive "contains" filter across code + name, for simple master-data search boxes. */
export function codeNameWhere(search?: string) {
  if (!search) return undefined;
  return {
    OR: [
      { code: { contains: search, mode: 'insensitive' as const } },
      { name: { contains: search, mode: 'insensitive' as const } },
    ],
  };
}
