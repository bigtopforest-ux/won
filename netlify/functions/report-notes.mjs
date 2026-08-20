import { getStore } from "@netlify/blobs";

const STORE_NAME = "report-notes-data";
const KEY = "notes";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function checkAuth(req) {
  const expected = Netlify.env.get("TEAM_KEY");
  if (!expected) return true;
  const key = req.headers.get("x-team-key");
  return key === expected;
}

async function loadNotes(s) {
  const data = await s.get(KEY, { type: "json" });
  return data || [];
}

export default async (req, context) => {
  const s = store();

  if (req.method === "GET") {
    const data = await loadNotes(s);
    return json(data);
  }

  if (req.method === "POST") {
    if (!checkAuth(req)) return json({ error: "unauthorized" }, 401);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    const { action } = body;
    const now = new Date().toISOString();

    if (action === "add") {
      const { 내용, 작성자 } = body;
      if (!내용 || !String(내용).trim()) return json({ error: "내용 required" }, 400);
      const data = await loadNotes(s);
      const newId = data.length ? Math.max(...data.map((n) => n.id)) + 1 : 1;
      const note = { id: newId, 내용: String(내용).trim(), 작성자: (작성자 || "").trim(), 등록일시: now };
      data.push(note);
      await s.setJSON(KEY, data);
      return json(note, 201);
    }

    if (action === "delete") {
      const { id } = body;
      const data = await loadNotes(s);
      const idx = data.findIndex((n) => n.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      data.splice(idx, 1);
      await s.setJSON(KEY, data);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 404);
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: ["/api/report-notes"],
};
