// Rep Ledger API: a Cloudflare Pages Function that reads and writes your private data repo.
// The GitHub token lives only here, as an encrypted Cloudflare secret. The browser never sees it.
//
//   GET  /api/data    -> { head, files: { "exercises/x.md": "...", "log/2026.csv": "..." } }
//   POST /api/commit  -> one commit containing every pending change
//
// Environment variables (Pages project > Settings > Variables and Secrets):
//   GITHUB_TOKEN        fine-grained token: only the data repo, "Contents: Read and write"   (secret)
//   DATA_REPO           e.g. "adrian/rep-ledger-data"
//   DATA_BRANCH         optional, defaults to "main"
//   ACCESS_TEAM_DOMAIN  e.g. "adrian.cloudflareaccess.com"
//   ACCESS_AUD          the Application Audience (AUD) tag of your Cloudflare Access application

import { updateLog } from '../../public/format.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export async function onRequest({ request, env, params }) {
  const route = (params.path || []).join('/');
  try {
    await requireAccess(request, env);
  } catch (e) {
    return json({ error: 'Sign-in required. Reload the page to sign in again.' }, 401);
  }
  try {
    checkConfig(env);
    if (request.method === 'GET' && route === 'data') return json(await loadData(env));
    if (request.method === 'POST' && route === 'commit') return json(await commit(env, await request.json()));
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    return json({ error: e.publicMessage || 'GitHub request failed: ' + String(e.message || e).slice(0, 300) }, e.status || 502);
  }
}

function checkConfig(env) {
  const missing = ['GITHUB_TOKEN', 'DATA_REPO'].filter((k) => !env[k]);
  if (missing.length) throw Object.assign(new Error(), { status: 500, publicMessage: 'Missing setting: ' + missing.join(', ') + '. Add it in the Pages project settings and redeploy.' });
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.DATA_REPO)) throw Object.assign(new Error(), { status: 500, publicMessage: 'DATA_REPO should look like "owner/repo".' });
}
const repoParts = (env) => { const [owner, name] = env.DATA_REPO.split('/'); return { owner, name, branch: env.DATA_BRANCH || 'main' }; };

/* ---------- Cloudflare Access: verify the signed identity header ---------- */

let certCache = { at: 0, keys: [] };
const b64urlBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function requireAccess(request, env) {
  if (env.DEV_SKIP_ACCESS === '1') return; // local testing only, never set this in production
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error('no access token');
  const domain = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const [h, p, sig] = token.split('.');
  const header = b64urlJson(h), payload = b64urlJson(p);
  if (Date.now() - certCache.at > 3600e3 || !certCache.keys.some((k) => k.kid === header.kid)) {
    const res = await fetch('https://' + domain + '/cdn-cgi/access/certs');
    if (!res.ok) throw new Error('cannot load access certs');
    certCache = { at: Date.now(), keys: (await res.json()).keys || [] };
  }
  const jwk = certCache.keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(sig), new TextEncoder().encode(h + '.' + p));
  if (!ok) throw new Error('bad signature');
  const now = Date.now() / 1000;
  if (!payload.exp || payload.exp < now) throw new Error('expired');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new Error('wrong audience');
  if (payload.iss && payload.iss.replace(/^https?:\/\//, '').replace(/\/+$/, '') !== domain) throw new Error('wrong issuer');
}

/* ---------- GitHub GraphQL ---------- */

async function gql(env, query, variables) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.GITHUB_TOKEN, 'content-type': 'application/json', 'user-agent': 'rep-ledger' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch (e) { body = { message: text }; }
  if (res.status === 401) throw Object.assign(new Error(), { status: 502, publicMessage: 'GitHub rejected the token. Check GITHUB_TOKEN in the Pages settings.' });
  if (!res.ok || body.errors) {
    const msg = body.errors ? body.errors.map((e) => e.message).join('; ') : body.message || res.status;
    throw Object.assign(new Error(String(msg)), { gqlErrors: body.errors || [] });
  }
  return body.data;
}

const TREE_FIELDS = '... on Tree { entries { name type object { ... on Blob { text isTruncated } } } }';

async function rawFile(env, path) {
  const { owner, name, branch } = repoParts(env);
  const res = await fetch('https://api.github.com/repos/' + owner + '/' + name + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(branch), {
    headers: { authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github.raw', 'user-agent': 'rep-ledger' },
  });
  if (!res.ok) throw new Error('could not read ' + path);
  return res.text();
}

async function loadData(env) {
  const { owner, name, branch } = repoParts(env);
  const data = await gql(env, `query($owner:String!,$name:String!,$ref:String!,$ex:String!,$log:String!){
    repository(owner:$owner,name:$name){
      ref(qualifiedName:$ref){ target { oid } }
      ex: object(expression:$ex){ ${TREE_FIELDS} }
      log: object(expression:$log){ ${TREE_FIELDS} }
    } }`, { owner, name, ref: 'refs/heads/' + branch, ex: branch + ':exercises', log: branch + ':log' });
  const repo = data.repository;
  if (!repo) throw Object.assign(new Error(), { status: 502, publicMessage: 'Repo ' + env.DATA_REPO + ' not found, or the token can\'t see it.' });
  if (!repo.ref) throw Object.assign(new Error(), { status: 502, publicMessage: 'Branch "' + branch + '" not found in ' + env.DATA_REPO + '. Make sure the repo has at least one commit.' });
  const files = {};
  const take = async (dir, tree, keep) => {
    for (const e of (tree && tree.entries) || []) {
      if (e.type !== 'blob' || !keep.test(e.name) || !e.object) continue;
      const path = dir + '/' + e.name;
      files[path] = e.object.isTruncated || e.object.text == null ? await rawFile(env, path) : e.object.text;
    }
  };
  await take('exercises', repo.ex, /\.md$/i);
  await take('log', repo.log, /^\d{4}\.csv$/);
  return { head: repo.ref.target.oid, files };
}

/* ---------- commit every pending change at once ---------- */

const toB64 = (s) => { const bytes = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const safePath = (p) => typeof p === 'string' && /^(exercises\/[^/]+\.md|log\/\d{4}\.csv)$/.test(p) && !p.includes('..');

async function commit(env, payload) {
  const files = payload.files || {}, deletions = (payload.deletions || []).filter((p) => !(p in files)), logs = payload.logs || {};
  for (const p of [...Object.keys(files), ...deletions]) if (!safePath(p)) throw Object.assign(new Error(), { status: 400, publicMessage: 'Refusing to write ' + p });
  const years = Object.keys(logs).filter((y) => /^\d{4}$/.test(y));
  const message = String(payload.message || 'Update from Rep Ledger').slice(0, 200);
  const { owner, name, branch } = repoParts(env);

  for (let attempt = 0; attempt < 4; attempt++) {
    // 1. current head, current log files, and which deleted paths still exist
    const vars = { owner, name, ref: 'refs/heads/' + branch };
    const fields = [];
    years.forEach((y, i) => { vars['l' + i] = branch + ':log/' + y + '.csv'; fields.push(`l${i}: object(expression:$l${i}){ ... on Blob { text isTruncated } }`); });
    deletions.forEach((p, i) => { vars['d' + i] = branch + ':' + p; fields.push(`d${i}: object(expression:$d${i}){ id }`); });
    const decl = Object.keys(vars).map((k) => '$' + k + ':String!').join(',');
    const data = await gql(env, `query(${decl}){ repository(owner:$owner,name:$name){ ref(qualifiedName:$ref){ target { oid } } ${fields.join(' ')} } }`, vars);
    const repo = data.repository;
    if (!repo || !repo.ref) throw Object.assign(new Error(), { status: 502, publicMessage: 'Data repo or branch not found.' });

    const additions = Object.entries(files).map(([path, text]) => ({ path, contents: toB64(String(text)) }));
    for (let i = 0; i < years.length; i++) {
      const y = years[i], blob = repo['l' + i];
      let text = blob ? blob.text : '';
      if (blob && (blob.isTruncated || blob.text == null)) text = await rawFile(env, 'log/' + y + '.csv');
      const L = logs[y] || {};
      additions.push({ path: 'log/' + y + '.csv', contents: toB64(updateLog(text || '', L.remove || [], L.append || [])) });
    }
    const dels = deletions.filter((p, i) => repo['d' + i]).map((path) => ({ path }));
    if (!additions.length && !dels.length) return { ok: true, head: repo.ref.target.oid, unchanged: true };

    // 2. one commit; fails cleanly if someone else committed in between, then we retry on the new head
    try {
      const out = await gql(env, `mutation($input:CreateCommitOnBranchInput!){ createCommitOnBranch(input:$input){ commit { oid } } }`, {
        input: {
          branch: { repositoryNameWithOwner: env.DATA_REPO, branchName: branch },
          expectedHeadOid: repo.ref.target.oid,
          message: { headline: message },
          fileChanges: { additions, deletions: dels },
        },
      });
      return { ok: true, head: out.createCommitOnBranch.commit.oid };
    } catch (e) {
      const stale = (e.gqlErrors || []).some((x) => x.type === 'STALE_DATA' || /expected|head|stale/i.test(x.message || ''));
      if (!stale || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 200 + Math.random() * 400));
    }
  }
}
