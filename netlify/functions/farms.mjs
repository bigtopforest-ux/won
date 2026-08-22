import { getStore } from "@netlify/blobs";
import seedData from "./seed-data.mjs";

const STORE_NAME = "farms-data";
const KEY = "farms";
const IMAGE_STORE_NAME = "farms-images";

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

// 상태: '진행중' | '드랍' | '계약완료'
function normalizeStatus(f) {
  if (f.상태 === "진행중" || f.상태 === "드랍" || f.상태 === "계약완료") return f.상태;
  return f.드랍여부 ? "드랍" : "진행중";
}

function classifyStage(stage, status) {
  if (status === "드랍") return "드랍";
  if (status === "계약완료") return "계약완료";
  const s = stage || "";
  if (s.includes("3차") || s.includes("최종")) return "3차미팅 이상";
  if (s.includes("2차")) return "2차미팅";
  if (s.includes("불발")) return "1차미팅 불발";
  if (s.includes("1차")) return "1차미팅";
  if (s.includes("유선") || s.includes("접촉") || s.includes("방문")) return "초기 접촉(유선/방문)";
  if (s.trim() === "") return "상태 미기재";
  return "기타";
}

function checkAuth(req) {
  const expected = Netlify.env.get("TEAM_KEY");
  if (!expected) return true;
  const key = req.headers.get("x-team-key");
  return key === expected;
}

// 서버는 UTC로 동작하므로 한국시간(UTC+9) 기준 "N월 N일" 문자열로 변환
function kstMonthDayStr() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`;
}

function migrate(data) {
  let changed = false;
  const out = data.map((f) => {
    const status = normalizeStatus(f);
    // 등록일시(입력시작일자)가 없는 기존 레코드는 최근수정시각으로 대신 채워서 월별 신규 발굴 집계가 빠지지 않도록 함
    const 등록일시 = f.등록일시 || f.최근수정시각 || new Date().toISOString();
    if (f.상태 !== status || f.드랍여부 !== (status === "드랍") || f.등록일시 !== 등록일시) changed = true;
    return { ...f, 상태: status, 드랍여부: status === "드랍", 등록일시 };
  });
  return { out, changed };
}

async function loadFarms(s) {
  let data = await s.get(KEY, { type: "json" });
  if (!data) {
    data = seedData;
  }
  const { out, changed } = migrate(data);
  if (changed) await s.setJSON(KEY, out);
  return out;
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

    if (id === null || id === undefined) {
      const newId = data.length ? Math.max(...data.map((f) => f.id)) + 1 : 1;
      const newFarm = {
        id: newId,
        농가명: "",
        담당자: "",
        농장주: "",
        지역: "",
        규모: "",
        돈사형태: "",
        현재거래처: "",
        접촉단계: "",
        사양가니즈: "",
        대여금유무: "",
        가능성: null,
        거래가능일자: "",
        차주액션: "",
        등급: "",
        최초등록: "수기입력",
        최근업데이트: "수기입력",
        이력횟수: 0,
        상태: "진행중",
        드랍여부: false,
        이력: [],
        미팅이력: [],
        ...updates,
      };
      newFarm.상태 = normalizeStatus(newFarm);
      newFarm.드랍여부 = newFarm.상태 === "드랍";
      newFarm.stage_bucket = classifyStage(newFarm.접촉단계, newFarm.상태);
      newFarm.최근수정자 = editor || "";
      newFarm.최근수정시각 = new Date().toISOString();
      newFarm.등록일시 = newFarm.최근수정시각;
      newFarm.최근업데이트 = kstMonthDayStr();
      data.push(newFarm);
      await s.setJSON(KEY, data);
      return json(newFarm, 201);
    }

    const idx = data.findIndex((f) => f.id === id);
    if (idx === -1) return json({ error: "not found" }, 404);

    const merged = { ...data[idx], ...updates };
    merged.상태 = normalizeStatus(merged);
    merged.드랍여부 = merged.상태 === "드랍";
    merged.stage_bucket = classifyStage(merged.접촉단계, merged.상태);
    merged.최근수정자 = editor || merged.최근수정자 || "";
    merged.최근수정시각 = new Date().toISOString();
    merged.최근업데이트 = kstMonthDayStr();
    data[idx] = merged;

    await s.setJSON(KEY, data);
    return json(merged);
  }

  if (req.method === "POST") {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/reset")) {
      if (!checkAuth(req)) return json({ error: "unauthorized" }, 401);
      const { out } = migrate(seedData);
      await s.setJSON(KEY, out);
      return json({ ok: true, count: out.length });
    }

    if (!checkAuth(req)) return json({ error: "unauthorized" }, 401);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    const { action } = body;

    // 농장 이미지 업로드: 프론트에서 base64로 인코딩해 보내면 별도 Blobs store(바이너리)에 저장하고,
    // 해당 거래처 레코드의 이미지목록 배열에 참조(key/파일명/업로드정보)만 남긴다.
    if (action === "uploadFarmImage") {
      const { id, 파일명, contentType, dataBase64, editor } = body;
      if (!id || !dataBase64) return json({ error: "id, dataBase64 required" }, 400);

      const data = await loadFarms(s);
      const idx = data.findIndex((f) => f.id === id);
      if (idx === -1) return json({ error: "farm not found" }, 404);

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

      const images = Array.isArray(data[idx].이미지목록) ? data[idx].이미지목록.slice() : [];
      images.push({ key, 파일명: 파일명 || "", 업로드자: editor || "", 업로드시각: new Date().toISOString() });
      data[idx] = { ...data[idx], 이미지목록: images };
      await s.setJSON(KEY, data);
      return json({ ok: true, farm: data[idx] });
    }

    if (action === "deleteFarmImage") {
      const { id, key } = body;
      if (!id || !key) return json({ error: "id, key required" }, 400);

      const data = await loadFarms(s);
      const idx = data.findIndex((f) => f.id === id);
      if (idx === -1) return json({ error: "farm not found" }, 404);

      await imageStore().delete(key);

      const images = (Array.isArray(data[idx].이미지목록) ? data[idx].이미지목록 : []).filter((im) => im.key !== key);
      data[idx] = { ...data[idx], 이미지목록: images };
      await s.setJSON(KEY, data);
      return json({ ok: true, farm: data[idx] });
    }

    if (action === "deleteFarm") {
      const { id } = body;
      if (id === null || id === undefined) return json({ error: "id required" }, 400);

      let data = await loadFarms(s);
      const idx = data.findIndex((f) => f.id === id);
      if (idx === -1) return json({ error: "not found" }, 404);

      const images = Array.isArray(data[idx].이미지목록) ? data[idx].이미지목록 : [];
      await Promise.all(images.map((im) => imageStore().delete(im.key).catch(() => {})));

      data = data.filter((f) => f.id !== id);
      await s.setJSON(KEY, data);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 404);
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: ["/api/farms", "/api/farms/reset"],
};
