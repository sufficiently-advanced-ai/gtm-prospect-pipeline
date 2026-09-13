// Twenty CRM API client (REST + metadata GraphQL), with the pipeline's retry policy baked in.
// REST create responses wrap records as {data: {createCompany: {...}}}; note/task linking
// uses noteTargets/taskTargets with targetCompanyId/targetPersonId (companyId/personId 400).
import { requireTwentyApiKey, TWENTY_BASE_URL } from "./env.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let last = 0;
async function throttle() {
  // ~8 req/s — limits are 200/s burst but bulk loops stay polite
  const now = Date.now();
  const wait = Math.max(0, last + 125 - now);
  last = now + wait;
  if (wait) await sleep(wait);
}

let headers: Record<string, string> | null = null;
function getHeaders(): Record<string, string> {
  headers ??= {
    Authorization: `Bearer ${requireTwentyApiKey()}`,
    "Content-Type": "application/json",
  };
  return headers;
}

class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isNotFound(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

async function request(method: string, url: string, body?: unknown): Promise<any> {
  let transportRetried = false;
  let gatewayRetried = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await throttle();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: getHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      // transport flake: one ~60s retry (the connector-flake rule), regardless of prior 429s
      if (!transportRetried) { transportRetried = true; await sleep(60_000); continue; }
      throw e;
    }
    if (res.status === 429) { await sleep(30_000); continue; }
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      // proxy/container restart — same one-retry policy as a transport flake
      if (!gatewayRetried) { gatewayRetried = true; await sleep(60_000); continue; }
    }
    if (!res.ok) {
      const txt = await res.text();
      throw new ApiError(res.status, `${method} ${url} -> ${res.status}: ${txt.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`rate limited after retries: ${method} ${url}`);
}

export async function api(method: string, path: string, body?: unknown): Promise<any> {
  return request(method, TWENTY_BASE_URL + path, body);
}

export async function pageAll(plural: string, extraQuery = ""): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  while (true) {
    const q = `limit=60${extraQuery ? `&${extraQuery}` : ""}${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`;
    const j = await api("GET", `/rest/${plural}?${q}`);
    out.push(...(j?.data?.[plural] ?? []));
    if (j?.pageInfo?.hasNextPage && j?.pageInfo?.endCursor) cursor = j.pageInfo.endCursor;
    else break;
  }
  return out;
}

export async function metaGql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  // same retry/backoff policy as REST calls
  return request("POST", `${TWENTY_BASE_URL}/metadata`, { query, variables });
}

function createdRecord(json: any): any {
  const data = json?.data;
  if (!data) return json;
  const key = Object.keys(data).find((k) => k.startsWith("create"));
  return key ? data[key] : data;
}

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
}

// Twenty-side primaryLinkUrl values sometimes carry a scheme (https://acme.com) — check
// both spellings before concluding the company doesn't exist (duplicate-create hazard).
export async function findCompanyByDomain(domain: string): Promise<any | null> {
  const d = normalizeDomain(domain);
  for (const variant of [d, `https://${d}`, `http://${d}`]) {
    const j = await api("GET", `/rest/companies?filter=domainName.primaryLinkUrl[eq]:${encodeURIComponent(variant)}&limit=10`);
    const hit = j?.data?.companies?.[0];
    if (hit) return hit;
  }
  return null;
}

export async function findPersonByApolloId(apolloContactId: string): Promise<any | null> {
  const j = await api("GET", `/rest/people?filter=apolloContactId[eq]:${encodeURIComponent(apolloContactId)}&limit=10`);
  return j?.data?.people?.[0] ?? null;
}

export async function findPersonByEmail(email: string): Promise<any | null> {
  const j = await api("GET", `/rest/people?filter=emails.primaryEmail[eq]:${encodeURIComponent(email.toLowerCase())}&limit=10`);
  return j?.data?.people?.[0] ?? null;
}

export async function upsertCompany(domain: string, payload: Record<string, unknown>, knownId?: string): Promise<string> {
  if (knownId) {
    try {
      await api("PATCH", `/rest/companies/${knownId}`, payload);
      return knownId;
    } catch (e) {
      if (!isNotFound(e)) throw e; // deleted in the UI — fall through to find/create
    }
  }
  const existing = await findCompanyByDomain(domain);
  if (existing) {
    await api("PATCH", `/rest/companies/${existing.id}`, payload);
    return existing.id;
  }
  const j = await api("POST", "/rest/companies", {
    ...payload,
    domainName: { primaryLinkUrl: normalizeDomain(domain) },
  });
  const rec = createdRecord(j);
  if (!rec?.id) throw new Error(`company create returned no id for ${domain}: ${JSON.stringify(j).slice(0, 200)}`);
  return rec.id;
}

export async function upsertPerson(payload: Record<string, unknown>, apolloContactId?: string, knownId?: string, email?: string): Promise<string> {
  if (knownId) {
    try {
      await api("PATCH", `/rest/people/${knownId}`, payload);
      return knownId;
    } catch (e) {
      if (!isNotFound(e)) throw e; // deleted in the UI — fall through to find/create
    }
  }
  const existing =
    (apolloContactId ? await findPersonByApolloId(apolloContactId) : null) ??
    (email ? await findPersonByEmail(email) : null);
  if (existing) {
    await api("PATCH", `/rest/people/${existing.id}`, payload);
    return existing.id;
  }
  const j = await api("POST", "/rest/people", payload);
  const rec = createdRecord(j);
  if (!rec?.id) throw new Error(`person create returned no id: ${JSON.stringify(j).slice(0, 200)}`);
  return rec.id;
}

export async function addNote(
  title: string,
  markdown: string,
  targets: Array<{ targetCompanyId?: string; targetPersonId?: string }>,
): Promise<string> {
  const n = await api("POST", "/rest/notes", { title, bodyV2: { markdown } });
  const noteId = createdRecord(n)?.id;
  if (!noteId) throw new Error("note create returned no id");
  for (const t of targets) await api("POST", "/rest/noteTargets", { noteId, ...t });
  return noteId;
}

export async function addTask(
  title: string,
  markdown: string,
  dueAt: string | null,
  targets: Array<{ targetCompanyId?: string; targetPersonId?: string }>,
): Promise<string> {
  const t = await api("POST", "/rest/tasks", {
    title,
    bodyV2: { markdown },
    status: "TODO",
    ...(dueAt ? { dueAt } : {}),
  });
  const taskId = createdRecord(t)?.id;
  if (!taskId) throw new Error("task create returned no id");
  for (const tt of targets) await api("POST", "/rest/taskTargets", { taskId, ...tt });
  return taskId;
}

// Flip a task to DONE — used by the decision mirror when a ledger entry resolves.
// Tasks are the one mirrored object whose status flows store→CRM in both directions of
// its lifecycle (created TODO, completed DONE); nothing reads task status back.
export async function completeTask(taskId: string): Promise<void> {
  await api("PATCH", `/rest/tasks/${taskId}`, { status: "DONE" });
}
