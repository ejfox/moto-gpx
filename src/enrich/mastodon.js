/**
 * mastodon.js — tie a user's public toots to GPS positions on their ride.
 *
 * Role in the pipeline: opt-in enrichment (`--mastodon @user@instance.social`,
 * or via MOTO_GPX_MASTODON env var). Fetches the user's public timeline,
 * filters to the trip's time window ±1h, interpolates each toot's position
 * along the track using its `created_at` timestamp, writes `toots.geojson`.
 * Downstream: shown as numbered circles on preview-map.svg, listed in the
 * superlatives banner as "posted during the ride".
 *
 * Contract: fail-soft. Bad handle → null. API 5xx / network failure → null.
 * The main run continues either way — the tool doesn't need social data to
 * produce its core output.
 *
 * External API: https://{instance}/api/v1/accounts/…
 *   Mastodon's public REST API. No auth required for public statuses.
 *   Rate limit: ~300 req/5min unauthenticated per instance.
 *   Response schema: https://docs.joinmastodon.org/entities/Status/
 *
 * Pagination: walks backward 25 pages × 40 statuses = 1000 max. For a ride
 * you took today, your toots are all on page 1. For older trips, accounts
 * with <~3 toots/day stay reachable for ~1 year back.
 *
 * Exports:
 *   fetchMastodonPosts(handle, perStage, deduped, outDir, trip)
 *     → { count, account, scanned, features } | null
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { interpolateAt } from '../media.js';

// Parse "@user@instance.social" or "https://instance.social/@user" or
// "user@instance.social" — return { username, instance }.
function parseHandle(raw) {
  if (!raw) return null;
  const s = raw.trim();
  const urlMatch = s.match(/^https?:\/\/([^/]+)\/@([^/?#]+)/);
  if (urlMatch) return { instance: urlMatch[1], username: urlMatch[2] };
  const handleMatch = s.match(/^@?([^@\s]+)@([^@\s]+)$/);
  if (handleMatch) return { username: handleMatch[1], instance: handleMatch[2] };
  return null;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'moto-gpx/0.4', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function lookupAccount(instance, username) {
  const url = `https://${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`;
  return fetchJson(url);
}

// Walk the user's timeline backwards until we pass windowStartMs or hit a
// hard page cap. 40 statuses/page, 25 pages = 1000 statuses — plenty for any
// recent ride, enough to reach months back for lower-volume accounts.
async function fetchStatusesUntil(instance, accountId, windowStartMs) {
  const out = [];
  let maxId = null;
  for (let pages = 0; pages < 25; pages++) {
    const qs = `limit=40&exclude_reblogs=true${maxId ? `&max_id=${maxId}` : ''}`;
    const url = `https://${instance}/api/v1/accounts/${accountId}/statuses?${qs}`;
    const page = await fetchJson(url);
    if (!Array.isArray(page) || page.length === 0) break;
    out.push(...page);
    const oldestT = Date.parse(page[page.length - 1].created_at);
    if (!Number.isFinite(oldestT) || oldestT < windowStartMs) break;
    maxId = page[page.length - 1].id;
  }
  return out;
}

export async function fetchMastodonPosts(handle, perStage, deduped, outDir, trip) {
  const parsed = parseHandle(handle);
  if (!parsed) {
    console.error(`    mastodon: couldn't parse handle "${handle}" (expected @user@instance.social)`);
    return null;
  }
  if (!deduped.length) return null;

  const firstT = deduped[0].time;
  const lastT = deduped[deduped.length - 1].time;
  const windowPad = 60 * 60 * 1000; // ±1 hour around the ride
  const windowStart = firstT - windowPad;
  const windowEnd = lastT + windowPad;

  let account;
  try {
    account = await lookupAccount(parsed.instance, parsed.username);
  } catch (e) {
    console.error(`    mastodon lookup failed: ${e.message}`);
    return null;
  }
  if (!account?.id) {
    console.error(`    mastodon: account not found: @${parsed.username}@${parsed.instance}`);
    return null;
  }

  let statuses;
  try {
    statuses = await fetchStatusesUntil(parsed.instance, account.id, windowStart);
  } catch (e) {
    console.error(`    mastodon fetch failed: ${e.message}`);
    return null;
  }

  const inWindow = statuses.filter(s => {
    const t = Date.parse(s.created_at);
    return Number.isFinite(t) && t >= windowStart && t <= windowEnd && !s.reblog;
  });

  const oldestSeen = statuses.length ? statuses[statuses.length - 1]?.created_at : null;
  console.log(`    scanned ${statuses.length} status${statuses.length === 1 ? '' : 'es'} back to ${oldestSeen?.slice(0, 10) ?? '—'}, ${inWindow.length} in trip window`);

  // Match each toot to its interpolated position on the track.
  const features = [];
  for (const s of inWindow) {
    const t = Date.parse(s.created_at);
    const pos = interpolateAt(deduped, t);
    if (!pos) continue;
    // Only accept if the toot time actually falls inside the ride window
    // (interpolateAt snaps to first/last trkpt via `edge: 'before'|'after'`
    // when outside, which we don't want to plot).
    if (pos.edge) continue;

    const content = stripHtml(s.content);
    features.push({
      type: 'Feature',
      properties: {
        trip,
        source: 'mastodon',
        account: `@${parsed.username}@${parsed.instance}`,
        content: content.length > 280 ? content.slice(0, 277) + '…' : content,
        url: s.url,
        time_iso: new Date(t).toISOString(),
        replies: s.replies_count ?? 0,
        reblogs: s.reblogs_count ?? 0,
        favourites: s.favourites_count ?? 0,
        media_count: s.media_attachments?.length ?? 0,
        media_urls: (s.media_attachments ?? []).map(m => m.url).filter(Boolean),
        sensitive: !!s.sensitive,
        spoiler_text: s.spoiler_text || null,
        tags: (s.tags ?? []).map(t => t.name),
      },
      geometry: {
        type: 'Point',
        coordinates: pos.ele != null ? [pos.lon, pos.lat, pos.ele] : [pos.lon, pos.lat],
      },
    });
  }

  features.sort((a, b) => Date.parse(a.properties.time_iso) - Date.parse(b.properties.time_iso));
  features.forEach((f, i) => { f.properties.index = i + 1; });

  const fc = {
    type: 'FeatureCollection',
    properties: {
      trip,
      source: 'mastodon',
      account: `@${parsed.username}@${parsed.instance}`,
      count: features.length,
      window: [new Date(windowStart).toISOString(), new Date(windowEnd).toISOString()],
    },
    features,
  };
  writeFileSync(join(outDir, 'toots.geojson'), JSON.stringify(fc));

  return {
    count: features.length,
    account: `@${parsed.username}@${parsed.instance}`,
    scanned: statuses.length,
    features, // returned so moto-gpx.js can feed them to the map renderer + superlatives
  };
}
