import { getStore } from "@netlify/blobs";
import seedData from "./heatwave-seed-data.mjs";

const STORE_NAME = "heatwave-data";
const KEY = "farms";
const IMAGE_STORE_NAME = "heatwave-images";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function imageStore() {
  return getStore({ name: IMAGE_STORE_NAME, consistency: "strong" });
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

// 엑셀 파싱 초기 버전이 각 농장 표의 "계"(합계) 행을 일반 신고내역으로 잘못 포함시켜
// 두수가 정확히 2배로 부풀려지는 버그가 있었음 — 이미 배포된 데이터를 로드 시점에 자동 정리한다.
function cleanIncidents(list) {
  return (Array.isArray(list) ? list : []).filter(
    (x) => x && !["계", "합계", "total"].includes(String(x.날짜 || "").trim())
  );
}

async function loadFarms(s) {
  let data = await s.get(KEY, { type: "json" });
  let isNew = false;
  if (!data) {
    data = seedData;
    isNew = true;
  }
  let changed = false;
  const cleaned = data.map((f) => {
    const list = cleanIncidents(f.신고내역);
    if (list.length !== (Array.isArray(f.신고내역) ? f.신고내역.length : 0)) changed = true;
    return list.length === (f.신고내역 || []).length ? f : { ...f, 신고내역: list };
  });
  if (isNew || changed) await s.setJSON(KEY, cleaned);
  return cleaned;
}

export default async (req, context) => {
  const s = store();

  if (req.method === "GET") {
    const url = new URL(req.url);
    const imgKey = url.searchParams.get("image");
    if (imgKey) {
      const result = await imageStore().getWithMetadata(imgKey, { type: "arrayBuffer" });
      if (!result || !result.data) return new Response("Not found", { status: 404 });
      const contentType = (result.metadata && result.metadata.contentType) || "application/octet-stream";
      return new Response(result.data, {
        status: 200,
        headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    const data = await loadFarms(s);
    return json(data);
  }

  if (req.method === "PUT") {
    if (!checkAuth(req)) return json({ error: "unauthorized" }, 401);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    const { id, updates, editor } = body;
    if (!updates || typeof updates !== "object") {
      return json({ error: "updates object required" }, 400);
    }

    const data = await loadFarms(s);
    const now = new Date().toISOString();

    if (id === null || id === undefined) {
      if (!updates.농장명 || !String(updates.농장명).trim()) return json({ error: "농장명 required" }, 400);
      if (data.some((f) => f.농장명 === updates.농장명)) return json({ error: "이미 등록된 농장명입니다" }, 400);
      const newId = data.length ? Math.max(...data.map((f) => f.id)) + 1 : 1;
      const newFarm = {
        id: newId,
        농장명: "",
        담당자: "",
        신고내역: [],
        총괄표이미지: null,
        ...updates,
        등록자: editor || "",
        등록시각: now,
      };
      data.push(newFarm);
      await s.setJSON(KEY, data);
      return json(newFarm, 201);
    }

    const idx = data.findIndex((f) => f.id === id);
    if (idx === -1) return json({ error: "not found" }, 404);

    const merged = { ...data[idx], ...updates, 최근수정자: editor || data[idx].최근수정자 || "", 최근수정시각: now };
    data[idx] = merged;
    await s.setJSON(KEY, data);
    return json(merged);
  }

  if (req.method === "POST") {
    if (!checkAuth(req)) return json({ error: "unauthorized" }, 401);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    const { action, editor } = body;
    const now = new Date().toISOString();

    if (action === "deleteFarm") {
      const { id } = body;
      const data = await loadFarms(s);
      const idx = data.findIndex((f) => f.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      if (data[idx].총괄표이미지 && data[idx].총괄표이미지.key) {
        await imageStore().delete(data[idx].총괄표이미지.key);
      }
      data.splice(idx, 1);
      await s.setJSON(KEY, data);
      return json({ ok: true });
    }

    if (action === "addIncident") {
      const { id, 날짜, 두수, 동 } = body;
      if (!날짜 || !두수) return json({ error: "날짜, 두수 required" }, 400);
      const data = await loadFarms(s);
      const idx = data.findIndex((f) => f.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      const list = Array.isArray(data[idx].신고내역) ? data[idx].신고내역.slice() : [];
      list.push({ 날짜: String(날짜).trim(), 두수: Number(두수) || 0, 동: (동 || "").trim(), 등록자: editor || "", 등록시각: now });
      data[idx] = { ...data[idx], 신고내역: list };
      await s.setJSON(KEY, data);
      return json({ ok: true, farm: data[idx] });
    }

    if (action === "deleteIncident") {
      const { id, index } = body;
      const data = await loadFarms(s);
      const idx = data.findIndex((f) => f.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      const list = Array.isArray(data[idx].신고내역) ? data[idx].신고내역.slice() : [];
      if (index < 0 || index >= list.length) return json({ error: "invalid index" }, 400);
      list.splice(index, 1);
      data[idx] = { ...data[idx], 신고내역: list };
      await s.setJSON(KEY, data);
      return json({ ok: true, farm: data[idx] });
    }

    if (action === "uploadSummaryImage") {
      const { id, 파일명, contentType, dataBase64 } = body;
      if (!id || !dataBase64) return json({ error: "id, dataBase64 required" }, 400);
      const data = await loadFarms(s);
      const idx = data.findIndex((f) => f.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);

      if (data[idx].총괄표이미지 && data[idx].총괄표이미지.key) {
        await imageStore().delete(data[idx].총괄표이미지.key);
      }

      let buf;
      try {
        buf = Buffer.from(dataBase64, "base64");
      } catch {
        return json({ error: "invalid dataBase64" }, 400);
      }
      const key = `${id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await imageStore().set(key, buf, {
        metadata: { contentType: contentType || "application/octet-stream", 파일명: 파일명 || "" },
      });
      data[idx] = { ...data[idx], 총괄표이미지: { key, 파일명: 파일명 || "", 업로드자: editor || "", 업로드시각: now } };
      await s.setJSON(KEY, data);
      return json({ ok: true, farm: data[idx] });
    }

    if (action === "deleteSummaryImage") {
      const { id } = body;
      const data = await loadFarms(s);
      const idx = data.findIndex((f) => f.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);
      if (data[idx].총괄표이미지 && data[idx].총괄표이미지.key) {
        await imageStore().delete(data[idx].총괄표이미지.key);
      }
      data[idx] = { ...data[idx], 총괄표이미지: null };
      await s.setJSON(KEY, data);
      return json({ ok: true, farm: data[idx] });
    }

    return json({ error: "unknown action" }, 404);
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: ["/api/heatwave"],
};
