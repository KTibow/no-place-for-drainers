/** Everything confirmed, in one file, for anything that would rather have JSON. */
import type { APIRoute } from 'astro';
import { loadRuns, loadSites } from '../data';

export const GET: APIRoute = () => {
  const runs = loadRuns();
  const sites = loadSites(runs);

  return new Response(
    JSON.stringify(
      {
        generated: runs[0]?.summary.generated ?? null,
        count: sites.length,
        sites: sites.map((site) => ({
          ...site.latest,
          firstSeen: site.firstSeen,
          lastSeen: site.lastSeen,
          seenOn: site.seenOn,
        })),
      },
      null,
      2,
    ),
    { headers: { 'content-type': 'application/json' } },
  );
};
