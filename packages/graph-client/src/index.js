// @nereoos/graph-client — Microsoft-Graph-Wrapper (SharePoint + OneDrive + Outlook).
// App-only (client credentials). Dependency-frei (Node >=22 global fetch).
// LESEN: jederzeit. SCHREIBEN: nur mit Azure-Consent Sites.ReadWrite.All / Mail.Send
//   und über mutate() — das immer durch die Guardrails läuft (dryRun + Audit-Callback).
// Siehe ../../CLAUDE.md §2/§3 (Schreibmacht mit Mensch-im-Loop + Audit).

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

/**
 * Erzeugt einen Graph-Client mit Token-Caching, Paginierung, Drive-Helfern
 * und (optional abgesichertem) Schreibzugriff.
 *
 * @param {object} cfg  Graph-Credentials (graphConfigFromEnv()).
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  Wenn true, wird KEINE Mutation ausgeführt —
 *        mutate() gibt nur die geplante Operation zurück und meldet sie als "dry-run"
 *        an onWrite. Das ist das Mensch-im-Loop-Preview (Guardrail, CLAUDE.md §2).
 * @param {boolean} [opts.writeEnabled]  Ops-Kill-Switch (Guardrail 1, CLAUDE.md §2).
 *        Default = (process.env.GRAPH_WRITE_ENABLED === "1"). Ist er false, führt mutate()
 *        AUCH bei confirm/!dryRun KEINEN Netzwerk-Write aus — der Versuch wird als
 *        "blocked" auditiert. So kann es keinen Write am Kill-Switch vorbei geben,
 *        selbst wenn ein Aufrufer den App-Endpoint (requireWrite) umgeht.
 * @param {(op: object) => any} [opts.onWrite]  Audit-Callback. Wird bei JEDER Mutation
 *        aufgerufen (dry-run | blocked | ok | error). Der Aufrufer persistiert das z. B.
 *        nach App-Postgres. Fehler im Callback dürfen den Write nicht blockieren.
 */
export function createGraphClient(cfg, opts = {}) {
  const {
    dryRun = false,
    onWrite,
    writeEnabled = process.env.GRAPH_WRITE_ENABLED === "1",
  } = opts;
  let token = null;
  let expiresAt = 0;

  // Audit-Emit darf NIE den eigentlichen Write blockieren oder werfen.
  async function audit(op) {
    if (!onWrite) return;
    try { await onWrite(op); } catch (e) { console.error("[graph-client] Audit fehlgeschlagen:", e?.message); }
  }

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

  // Schreibender Graph-Aufruf (POST/PUT/PATCH/DELETE). EINZIGER Schreibpfad —
  // läuft immer durch Guardrails: dryRun stoppt vor dem Netzwerk, audit() protokolliert.
  // body: JSON-Objekt (-> application/json) ODER Buffer/Uint8Array (-> contentType).
  async function mutate(method, path, { json, body, contentType, label } = {}) {
    const op = { method, path, label: label ?? path };
    if (dryRun) {
      await audit({ ...op, status: "dry-run" });
      return { dryRun: true, ...op };
    }
    // Kill-Switch-Backstop: confirm/!dryRun reicht NICHT — ohne GRAPH_WRITE_ENABLED=1
    // wird nichts ans Netz geschickt. Letzte Verteidigungslinie am einzigen Write-Pfad.
    if (!writeEnabled) {
      await audit({ ...op, status: "blocked" });
      return { blocked: true, reason: "GRAPH_WRITE_ENABLED!=1", ...op };
    }
    const headers = { authorization: await authHeader(), accept: "application/json" };
    let payload;
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(json);
    } else if (body !== undefined) {
      headers["content-type"] = contentType ?? "application/octet-stream";
      payload = body;
    }
    const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
    const res = await fetch(url, { method, headers, body: payload });
    if (!res.ok) {
      const text = await res.text();
      let j = null;
      try { j = JSON.parse(text); } catch {}
      const err = new Error(`Graph ${method} ${path.replace(GRAPH, "")} → HTTP ${res.status}`);
      err.status = res.status;
      err.body = j?.error ?? text.slice(0, 400);
      await audit({ ...op, status: "error", httpStatus: res.status, error: err.body });
      throw err;
    }
    // 204 No Content (z. B. DELETE / sendMail) hat keinen Body.
    const out = res.status === 204 ? { ok: true } : await res.json().catch(() => ({ ok: true }));
    await audit({ ...op, status: "ok", httpStatus: res.status, resultId: out?.id });
    return out;
  }

  return {
    authHeader,
    tokenRoles: async () => tokenRoles((await authHeader()).slice(7)),
    get: request,
    getAll,
    mutate,
    dryRun,
    writeEnabled,

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
            `?$select=id,name,size,folder,file,webUrl,lastModifiedDateTime&$top=200`
        );
        const nodes = [];
        for (const k of kids) {
          const node = {
            name: k.name,
            id: k.id,
            type: k.folder ? "folder" : "file",
            size: k.size ?? 0,
            modified: k.lastModifiedDateTime,
            // webUrl nur für Ordner speichern (Quellen-Link zum Datenraum); hält den Index schlank.
            ...(k.folder ? { webUrl: k.webUrl } : {}),
          };
          // childCount nur als Optimierung: bei GENAU 0 (sicher leer) sparen wir den Call.
          // Fehlt childCount (undefined/null bei manchen Item-Typen) oder ist >0 → absteigen,
          // sonst gingen ganze Teilbäume still verloren (falsche Datei-/Kategorie-Zählung).
          if (k.folder && depth < maxDepth && k.folder.childCount !== 0) {
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
      // OData-Stringliteral: ' verdoppeln (sonst bricht ein Apostroph die Query / 400), dann URL-encoden.
      getAll(`/drives/${driveId}/root/search(q='${encodeURIComponent(String(q).replace(/'/g, "''"))}')?$top=200`),

    // --- Navigation (für die Workspace-Shell, CLAUDE.md §1: Struktur spiegeln) ---
    /** Item per relativem Pfad (Pfad-Adressierung). NUR für Bootstrap-Root-Auflösung —
     *  laufende Navigation läuft id-basiert (childByName), das ist sonderzeichen-immun.
     *  Pfadsegmente einzeln encodeURIComponent, ':' bleibt roher Delimiter; leerer Pfad → /root. */
    itemByPath(driveId, relPath = "") {
      const SEL = "id,name,size,folder,file,webUrl,lastModifiedDateTime,parentReference";
      const enc = String(relPath).split("/").filter(Boolean).map(encodeURIComponent).join("/");
      return request(
        enc
          ? `/drives/${driveId}/root:/${enc}?$select=${SEL}`
          : `/drives/${driveId}/root?$select=${SEL}`
      );
    },
    /** Ein direktes Kind eines bekannten Ordners per EXAKTEM Namen — id-basiert.
     *  Containment by construction: es werden nur Kinder eines bereits aufgelösten
     *  Elterns betrachtet. null, wenn nicht (mehr) vorhanden. */
    async childByName(driveId, parentItemId, name) {
      const kids = await getAll(
        `/drives/${driveId}/items/${parentItemId}/children` +
          `?$select=id,name,size,folder,file,webUrl,lastModifiedDateTime&$top=200`
      );
      // Exakt zuerst, dann case-insensitiv (SharePoint/OneDrive sind case-insensitive,
      // case-preserving) — so überleben gespeicherte Pfade eine reine Groß-/Kleinschreib-Umbenennung.
      const target = String(name);
      return (
        kids.find((k) => k.name === target) ??
        kids.find((k) => k.name.localeCompare(target, undefined, { sensitivity: "accent" }) === 0) ??
        null
      );
    },

    // --- Delta (Realtime-Sync, CLAUDE.md §3) ---
    /** Inkrementelle Änderungen einer Drive seit `token`.
     *  token=null     → Voll-Delta vom Start (alle Items + finaler deltaToken).
     *  token="latest" → nur den aktuellen deltaToken holen, OHNE Itemstrom (Bootstrap).
     *  token=<wert>   → nur Änderungen seit diesem Token.
     *  Liefert { items, deltaToken } (deltaToken aus @odata.deltaLink). */
    async driveDelta(driveId, token = null) {
      const SEL = "id,name,size,folder,file,deleted,parentReference,lastModifiedDateTime";
      let next =
        token === "latest"
          ? `/drives/${driveId}/root/delta?token=latest`
          : token
          ? `/drives/${driveId}/root/delta?token=${encodeURIComponent(token)}`
          : `/drives/${driveId}/root/delta?$select=${SEL}&$top=200`;
      const items = [];
      let deltaLink = null;
      while (next) {
        const page = await request(next);
        if (Array.isArray(page.value)) items.push(...page.value);
        if (page["@odata.deltaLink"]) { deltaLink = page["@odata.deltaLink"]; break; }
        next = page["@odata.nextLink"] ?? null;
      }
      const m = deltaLink && deltaLink.match(/[?&]token=([^&]+)/);
      return { items, deltaToken: m ? decodeURIComponent(m[1]) : null };
    },

    // ===================================================================
    // SCHREIBEN (Guardrails über mutate(): dryRun + Audit). Braucht in Azure
    // Application-Permission Sites.ReadWrite.All bzw. Mail.Send + Admin-Consent.
    // ===================================================================

    // --- Dateien ---
    /** Lädt eine neue Datei in einen Ordner hoch (Simple Upload, bis ~4 MB).
     *  Größere Dateien bräuchten eine Upload-Session (createUploadSession) — TODO. */
    uploadFile: (driveId, parentItemId, name, content, contentType) =>
      mutate(
        "PUT",
        `/drives/${driveId}/items/${parentItemId}:/${encodeURIComponent(name)}:/content`,
        { body: content, contentType, label: `upload ${name}` }
      ),
    /** Überschreibt den Inhalt einer bestehenden Datei. */
    replaceFile: (driveId, itemId, content, contentType) =>
      mutate("PUT", `/drives/${driveId}/items/${itemId}/content`,
        { body: content, contentType, label: `replace ${itemId}` }),
    /** Löscht ein Item (Datei oder Ordner) — wandert in den SharePoint-Papierkorb. */
    deleteItem: (driveId, itemId) =>
      mutate("DELETE", `/drives/${driveId}/items/${itemId}`, { label: `delete ${itemId}` }),
    /** Benennt ein Item um. */
    renameItem: (driveId, itemId, newName) =>
      mutate("PATCH", `/drives/${driveId}/items/${itemId}`,
        { json: { name: newName }, label: `rename ${itemId} -> ${newName}` }),
    /** Verschiebt ein Item in einen anderen Ordner. */
    moveItem: (driveId, itemId, newParentItemId) =>
      mutate("PATCH", `/drives/${driveId}/items/${itemId}`,
        { json: { parentReference: { id: newParentItemId } }, label: `move ${itemId} -> ${newParentItemId}` }),

    // --- Ordner / Struktur ---
    /** Legt einen neuen Ordner an (conflictBehavior=fail: kein stilles Überschreiben). */
    createFolder: (driveId, parentItemId, name) =>
      mutate("POST", `/drives/${driveId}/items/${parentItemId}/children`,
        { json: { name, folder: {}, "@microsoft.graph.conflictBehavior": "fail" }, label: `mkdir ${name}` }),

    // --- SharePoint-Metadaten (Status-/Listen-Spalten) ---
    /** Schreibt Spaltenwerte am Listen-Item (z. B. { Status: "von nereo geprüft", Risiko: "hoch" }). */
    updateListItemFields: (siteId, listId, itemId, fields) =>
      mutate("PATCH", `/sites/${siteId}/lists/${listId}/items/${itemId}/fields`,
        { json: fields, label: `fields list-item ${itemId}` }),
    /** Schreibt Metadaten direkt an einem Drive-Item (über dessen listItem-Beziehung). */
    setDriveItemFields: (driveId, itemId, fields) =>
      mutate("PATCH", `/drives/${driveId}/items/${itemId}/listItem/fields`,
        { json: fields, label: `fields drive-item ${itemId}` }),

    // --- Outlook (Mail senden, fürs Nachhaken) ---
    /** Sendet eine Mail im Namen von fromUserId. message = Graph-Message-Objekt. */
    sendMail: (fromUserId, message, saveToSentItems = true) =>
      mutate("POST", `/users/${encodeURIComponent(fromUserId)}/sendMail`,
        { json: { message, saveToSentItems },
          label: `mail -> ${(message?.toRecipients ?? []).map((r) => r.emailAddress?.address).join(", ")}` }),

    // ===================================================================
    // SUBSCRIPTIONS (Change-Notifications, Realtime-Sync). BEWUSST NICHT über mutate():
    // Subscriptions sind Graph-METADATEN (Benachrichtigungs-Plumbing), KEIN Schreiben in die
    // SSoT (SharePoint/Outlook). Daher kein Kill-Switch/Dry-run/Audit-Pfad. Read-only-Scope reicht.
    // ===================================================================
    createSubscription: ({ resource, notificationUrl, clientState, expirationDateTime, changeType = "updated" }) =>
      graphCall("POST", "/subscriptions", { changeType, notificationUrl, resource, clientState, expirationDateTime }),
    renewSubscription: (id, expirationDateTime) =>
      graphCall("PATCH", `/subscriptions/${id}`, { expirationDateTime }),
    deleteSubscription: (id) => graphCall("DELETE", `/subscriptions/${id}`),
    listSubscriptions: () => graphCall("GET", "/subscriptions"),
  };

  // Schlanker JSON-Graph-Call NUR für Subscription-CRUD (siehe Abgrenzung oben). Kein dryRun/Audit.
  async function graphCall(method, path, json) {
    const res = await fetch(`${GRAPH}${path}`, {
      method,
      headers: { authorization: await authHeader(), "content-type": "application/json", accept: "application/json" },
      body: json ? JSON.stringify(json) : undefined,
    });
    const text = await res.text();
    let j = null;
    try { j = JSON.parse(text); } catch {}
    if (!res.ok) {
      const err = new Error(`Graph ${method} ${path} → HTTP ${res.status}`);
      err.status = res.status;
      err.body = j?.error ?? text.slice(0, 400);
      throw err;
    }
    return res.status === 204 ? { ok: true } : j ?? { ok: true };
  }
}
