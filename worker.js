import * as Iron from "iron-webcrypto";

const SESSION_COOKIE = "__Host-notes-session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();

const sessionOptions = {
  ...Iron.defaults,
  ttl: SESSION_TTL_MS,
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function inlineMarkdown(value) {
  return value
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`(.+?)`/g, "<code>$1</code>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

function renderBody(body) {
  const escaped = escapeHtml(body).replace(/\r\n?/g, "\n");
  return inlineMarkdown(escaped).replace(/\n/g, "<br>\n");
}

function formatDate(timestamp) {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function formatRssDate(timestamp) {
  return new Date(timestamp * 1000).toUTCString();
}

function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const cookies = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;

    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

async function sessionPassword(password) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(password)),
  );
}

async function passwordMatches(password, candidate) {
  const expected = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(password)),
  );

  const actual = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  );

  if (expected.length !== actual.length) {
    return false;
  }

  return crypto.subtle.timingSafeEqual(expected, actual);
}

async function isAuthenticated(request, env) {
  const cookies = parseCookies(request);
  const sealed = cookies[SESSION_COOKIE];

  if (!sealed || !env.ADMIN_PASSWORD) {
    return false;
  }

  try {
    const password = await sessionPassword(env.ADMIN_PASSWORD);
    const session = await Iron.unseal(sealed, password, sessionOptions);

    return session?.authenticated === true;
  } catch {
    return false;
  }
}

function sessionCookie(value, request) {
  const secure = new URL(request.url).protocol === "https:";

  return [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function expiredSessionCookie(request) {
  const secure = new URL(request.url).protocol === "https:";

  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 303,
    headers: {
      Location: location,
      ...headers,
    },
  });
}

async function getNotes(env) {
  const result = await env.DB.prepare(
    "SELECT id, created_at, title, body FROM notes ORDER BY created_at DESC, id DESC",
  ).all();

  return result.results;
}

async function getNote(env, id) {
  return env.DB.prepare(
    "SELECT id, created_at, title, body FROM notes WHERE id = ?",
  )
    .bind(id)
    .first();
}

async function renderFeed(request, env) {
  const notes = await getNotes(env);
  const asset = await env.ASSETS.fetch(
    new Request(new URL("/index.html", request.url)),
  );

  if (!asset.ok) {
    return new Response("Missing public/index.html", { status: 500 });
  }

  let html = await asset.text();

  const notesHtml = notes
    .map(
      (note) => `
<article id="note-${escapeHtml(note.id)}">
  <header>
    <time datetime="${new Date(note.created_at * 1000).toISOString()}">${escapeHtml(formatDate(note.created_at))}</time>
    ${
      note.title
        ? `<h2>${inlineMarkdown(escapeHtml(note.title))}</h2>`
        : ""
    }
  </header>
  <div class="body">${renderBody(note.body)}</div>
</article>`,
    )
    .join("\n");

  html = html.replace("<!-- NOTES -->", notesHtml);

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

async function renderFeedXml(request, env) {
  const notes = await getNotes(env);
  const origin = new URL(request.url).origin;

  const items = notes
    .map((note) => {
      const title = note.title || formatDate(note.created_at);
      const link = `${origin}/?note=${encodeURIComponent(note.id)}#note-${encodeURIComponent(note.id)}`;

      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${escapeXml(formatRssDate(note.created_at))}</pubDate>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>notes</title>
    <link>${escapeXml(origin)}</link>
    <description>Personal notes</description>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=UTF-8",
      "Cache-Control": "no-store",
    },
  });
}

function adminLayout(content) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>admin — notes</title>
  <style>
    :root {
      color-scheme: light;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #fafafa;
      color: #111;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
        "Liberation Mono", "Courier New", monospace;
      line-height: 1.55;
    }

    main {
      width: min(65ch, calc(100% - 2rem));
      margin: 3rem auto;
    }

    a {
      color: inherit;
    }

    h1, h2 {
      font-size: 1rem;
      font-weight: 700;
    }

    textarea,
    input[type="text"],
    input[type="password"] {
      width: 100%;
      border: 1px solid #999;
      border-radius: 0;
      background: #fff;
      color: #111;
      font: inherit;
      padding: .6rem;
    }

    textarea {
      min-height: 18rem;
      resize: vertical;
    }

    button {
      border: 1px solid #111;
      border-radius: 0;
      background: #111;
      color: #fff;
      font: inherit;
      padding: .5rem .8rem;
      cursor: pointer;
    }

    form {
      margin: 1rem 0 2rem;
    }

    label {
      display: block;
      margin-bottom: .4rem;
    }

    .note {
      border-top: 1px solid #ccc;
      padding: 1rem 0;
    }

    .note-actions {
      display: flex;
      gap: .75rem;
      margin-top: .75rem;
    }

    .danger {
      background: #fff;
      color: #111;
    }

    .muted {
      color: #666;
    }
  </style>
</head>
<body>
  <main>
    ${content}
  </main>
</body>
</html>`;
}

function adminLoginPage(error = "") {
  return adminLayout(`
    <h1>admin</h1>

    ${error ? `<p>${escapeHtml(error)}</p>` : ""}

    <form method="post" action="/admin/login">
      <label for="password">password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <p><button type="submit">log in</button></p>
    </form>
  `);
}

function adminPage(notes, editingNote = null) {
  const editor = editingNote
    ? `
      <h2>edit note</h2>
      <form method="post" action="/admin/save">
        <input type="hidden" name="id" value="${escapeHtml(editingNote.id)}">

        <label for="title">title (optional)</label>
        <input id="title" name="title" type="text" value="${escapeHtml(editingNote.title || "")}">

        <label for="body">body</label>
        <textarea id="body" name="body" required>${escapeHtml(editingNote.body)}</textarea>

        <p>
          <button type="submit">save</button>
          <a href="/admin">cancel</a>
        </p>
      </form>
    `
    : `
      <h2>new note</h2>
      <form method="post" action="/admin/publish">
        <label for="title">title (optional)</label>
        <input id="title" name="title" type="text">

        <label for="body">body</label>
        <textarea id="body" name="body" required></textarea>

        <p><button type="submit">publish</button></p>
      </form>
    `;

  const list = notes.length
    ? notes
        .map(
          (note) => `
        <section class="note">
          <div>
            <strong>${escapeHtml(formatDate(note.created_at))}</strong>
            ${note.title ? ` — ${inlineMarkdown(escapeHtml(note.title))}` : ""}
          </div>
          <div class="muted">${escapeHtml(note.body.slice(0, 160))}${
            note.body.length > 160 ? "…" : ""
          }</div>
          <div class="note-actions">
            <a href="/admin/edit?id=${encodeURIComponent(note.id)}">edit</a>
            <form method="post" action="/admin/delete" style="margin:0">
              <input type="hidden" name="id" value="${escapeHtml(note.id)}">
              <button class="danger" type="submit">delete</button>
            </form>
          </div>
        </section>
      `,
        )
        .join("\n")
    : `<p class="muted">No notes yet.</p>`;

  return adminLayout(`
    <p><a href="/">public feed</a></p>
    <h1>admin</h1>

    ${editor}

    <h2>notes</h2>
    ${list}

    <form method="post" action="/admin/logout">
      <button class="danger" type="submit">log out</button>
    </form>
  `);
}

async function requireAdmin(request, env) {
  if (await isAuthenticated(request, env)) {
    return null;
  }

  return redirect("/admin/login");
}

async function handleAdminLogin(request, env) {
  if (request.method === "GET") {
    return new Response(adminLoginPage(), {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const form = await request.formData();
  const candidate = String(form.get("password") || "");

  if (!env.ADMIN_PASSWORD || !(await passwordMatches(env.ADMIN_PASSWORD, candidate))) {
    return new Response(adminLoginPage("Invalid password."), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  const password = await sessionPassword(env.ADMIN_PASSWORD);
  const sealed = await Iron.seal(
    { authenticated: true },
    password,
    sessionOptions,
  );

  return redirect("/", {
    "Set-Cookie": sessionCookie(sealed, request),
  });
}

async function handleAdmin(request, env) {
  const authRedirect = await requireAdmin(request, env);
  if (authRedirect) return authRedirect;

  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/admin") {
    const notes = await getNotes(env);

    return new Response(adminPage(notes), {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  if (request.method === "GET" && url.pathname === "/admin/edit") {
    const id = url.searchParams.get("id");

    if (!id) {
      return redirect("/admin");
    }

    const note = await getNote(env, id);

    if (!note) {
      return new Response("Not Found", { status: 404 });
    }

    const notes = await getNotes(env);

    return new Response(adminPage(notes, note), {
      headers: { "Content-Type": "text/html; charset=UTF-8" },
    });
  }

  if (request.method === "POST" && url.pathname === "/admin/publish") {
    const form = await request.formData();
    const title = String(form.get("title") || "").trim();
    const body = String(form.get("body") || "");

    if (!body.trim()) {
      return new Response("Body is required.", { status: 400 });
    }

    await env.DB.prepare(
      "INSERT INTO notes (id, created_at, title, body) VALUES (?, ?, ?, ?)",
    )
      .bind(
        crypto.randomUUID(),
        Math.floor(Date.now() / 1000),
        title || null,
        body,
      )
      .run();

    return redirect("/admin");
  }

  if (request.method === "POST" && url.pathname === "/admin/save") {
    const form = await request.formData();
    const id = String(form.get("id") || "");
    const title = String(form.get("title") || "").trim();
    const body = String(form.get("body") || "");

    if (!id || !body.trim()) {
      return new Response("Invalid note.", { status: 400 });
    }

    await env.DB.prepare(
      "UPDATE notes SET title = ?, body = ? WHERE id = ?",
    )
      .bind(title || null, body, id)
      .run();

    return redirect("/admin");
  }

  if (request.method === "POST" && url.pathname === "/admin/delete") {
    const form = await request.formData();
    const id = String(form.get("id") || "");

    if (!id) {
      return new Response("Invalid note.", { status: 400 });
    }

    await env.DB.prepare("DELETE FROM notes WHERE id = ?").bind(id).run();

    return redirect("/admin");
  }

  if (request.method === "POST" && url.pathname === "/admin/logout") {
    return redirect("/admin/login", {
      "Set-Cookie": expiredSessionCookie(request),
    });
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/feed.xml") {
      return renderFeedXml(request, env);
    }

    if (
      url.pathname === "/admin" ||
      url.pathname === "/admin/" ||
      url.pathname === "/admin/login" ||
      url.pathname === "/admin/edit" ||
      url.pathname === "/admin/publish" ||
      url.pathname === "/admin/save" ||
      url.pathname === "/admin/delete" ||
      url.pathname === "/admin/logout"
    ) {
      if (url.pathname === "/admin/" && request.method === "GET") {
        return redirect("/admin");
      }

      if (url.pathname === "/admin/login") {
        return handleAdminLogin(request, env);
      }

      return handleAdmin(request, env);
    }

    if (url.pathname === "/" && request.method === "GET") {
      return renderFeed(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
