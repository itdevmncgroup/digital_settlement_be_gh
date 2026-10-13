// Display label for the client side of an Expense Request: its Advertisers, else its Agencies
// (a Request may pick an Agency alone), else the legacy free-text name.
export function clientLabel(r: {
  clientName: string | null;
  advertisers?: { advertiser: { name: string } }[];
  agencies?: { agency: { name: string } }[];
}): string {
  const names = r.advertisers?.map((a) => a.advertiser.name) ?? [];
  if (names.length) return names.join(', ');
  const agencyNames = r.agencies?.map((a) => a.agency.name) ?? [];
  return agencyNames.length ? agencyNames.join(', ') : (r.clientName ?? '-');
}
