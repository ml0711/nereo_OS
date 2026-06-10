// @nereoos/graph-client — Microsoft-Graph-Wrapper (read-only: SharePoint + OneDrive + Outlook).
// App-only (client credentials). Dependency-frei (Node >=22 global fetch).
// nereo OS liest nur (read-only), editiert nichts. Siehe ../../CLAUDE.md §2/§3.

const AUTHORITY = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

/** Liest die Graph-Credentials aus der Umgebung und validiert sie. */
export function graphConfigFromEnv(env = process.env) {
  const cfg = {
    tenantId: env.MS_TENANT_ID,
    clientId: env.MS_CLIENT_ID,
    clientSecret: env.MS_CLIENT_SECRET,
  };
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    throw new Error(`Fehlende Graph-Env-Variablen: ${missing.join(", ")}`);
  }
  return cfg;
}

/** Holt ein App-only-Access-Token (client_credentials, scope=.default). */
export async function getAppToken(cfg) {
  const url = `${AUTHORITY}/${cfg.tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* nicht-JSON (z. B. Edge-404) */
  }
  if (!res.ok || !json?.access_token) {
    const err = new Error(`Token-Anfrage fehlgeschlagen (HTTP ${res.status})`);
    err.status = res.status;
    err.aadError = json?.error;
    err.body = (json ? JSON.stringify(json) : text).slice(0, 600);
    throw err;
  }
  return { accessToken: json.access_token, expiresIn: json.expires_in ?? 3600 };
}

/** Dekodiert die `roles` (consented App-Permissions) aus einem Access-Token. */
export function tokenRoles(accessToken) {
  try {
    const p = JSON.parse(
      Buffer.from(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    );
    return p.roles ?? [];
  } catch {
    return [];
  }
}

/** Erzeugt einen Graph-Client mit Token-Caching, Paginierung und Drive-Helfern. */
export function createGraphClient(cfg) {
  let token = null;
  let expiresAt = 0;

  async function authHeader() {
    const now = Date.now();
    if (!token || now >= expiresAt) {
      const t = await getAppToken(cfg);
      token = t.accessToken;
      expiresAt = now + (t.expiresIn - 60) * 1000;
    }
    return `Bearer ${token}`;
  }

  // Akzeptiert relativen Pfad ("/sites") ODER absolute Graph-URL (für @odata.nextLink).
  async function request(pathOrUrl, { raw = false } = {}) {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH}${pathOrUrl}`;
    const res = await fetch(url, {
      headers: { authorization: await authHeader(), accept: "application/json" },
    });
    if (!res.ok) {
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      const err = new Error(`Graph GET ${pathOrUrl.replace(GRAPH, "")} → HTTP ${res.status}`);
      err.status = res.status;
      err.body = json?.error ?? text.slice(0, 400);
      throw err;
    }
    return raw ? res : res.json();
  }

  // Folgt @odata.nextLink und sammelt alle Seiten in ein Array.
  async function getAll(path) {
    const out = [];
    let next = path;
    while (next) {
      const page = await request(next);
      if (Array.isArray(page.value)) out.push(...page.value);
      next = page["@odata.nextLink"] ?? null;
    }
    return out;
  }

  return {
    authHeader,
    tokenRoles: async () => tokenRoles((await authHeader()).slice(7)),
    get: request,
    getAll,

    // --- Verzeichnis / User ---
    listUsers: (select = "id,displayName,userPrincipalName,mail,accountEnabled") =>
      getAll(`/users?$select=${select}&$top=999`),

    // --- SharePoint-Sites ---
    listSites: (query = "*") => getAll(`/sites?search=${encodeURIComponent(query)}`),
    getSite: (hostname, sitePath) => request(`/sites/${hostname}:${sitePath}`),
    listSiteDrives: (siteId) => getAll(`/sites/${siteId}/drives?$select=id,name,driveType,webUrl`),

    // --- Drives (OneDrive for Business + Dokumentbibliotheken) ---
    getUserDrive: (upn) => request(`/users/${upn}/drive?$select=id,driveType,webUrl,quota`),
    listChildren: (driveId, itemId = null) =>
      getAll(
        `/drives/${driveId}/${itemId ? `items/${itemId}` : "root"}/children` +
          `?$select=id,name,size,folder,file,webUrl,lastModifiedDateTime&$top=200`
      ),

    /** Rekursiver Strukturbaum eines Drives (nur Metadaten, keine Inhalte). */
    async walkDrive(driveId, { itemId = null, maxDepth = 6 } = {}) {
      const visit = async (id, depth) => {
        const kids = await getAll(
          `/drives/${driveId}/${id ? `items/${id}` : "root"}/children` +
            `?$select=id,name,size,folder,file,lastModifiedDateTime&$top=200`
        );
        const nodes = [];
        for (const k of kids) {
          const node = {
            name: k.name,
            id: k.id,
            type: k.folder ? "folder" : "file",
            size: k.size ?? 0,
            modified: k.lastModifiedDateTime,
          };
          if (k.folder && k.folder.childCount > 0 && depth < maxDepth) {
            node.children = await visit(k.id, depth + 1);
          }
          nodes.push(node);
        }
        return nodes;
      };
      return visit(itemId, 0);
    },

    // --- Datei-Inhalte (read-only) ---
    /** Lädt den Roh-Inhalt einer Datei als Buffer. */
    async downloadItem(driveId, itemId) {
      const res = await request(`/drives/${driveId}/items/${itemId}/content`, { raw: true });
      return Buffer.from(await res.arrayBuffer());
    },

    // --- Suche ---
    searchDrive: (driveId, q) =>
      getAll(`/drives/${driveId}/root/search(q='${encodeURIComponent(q)}')?$top=200`),
  };
}
