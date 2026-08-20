import { getStore } from "@netlify/blobs";

const STORE_NAME = "medicine-costs";
const GROUPS_KEY = "groups";
const LIMITS_KEY = "manual-limits";
const EXCLUDED_KEY = "excluded-items";

// 처음 한 번도 저장된 적 없을 때 사용하는 기본 제외 품목(기존 코드에 하드코딩돼 있던 목록 + 코보정기)
const DEFAULT_EXCLUDED_ITEMS = [
  "연속주사기(2ml)", "연속주사기(5ml)",
  "일회용주사침18g(장침)", "일회용주사침18g(단침)",
  "일회용주사침19g(장침)", "일회용주사침19g(단침)",
  "포시겐PCV2(50두분)", "방역복(일반)", "방역복(FS코팅)",
  "주사기연결줄", "버콘에스-엑스", "트리플-CAN", "웰빙팜",
  "수술용장갑", "비닐장화", "마스크", "직납", "판탈-8",
  "써코플렉스", "뉴파워킬", "일회용주사기(10ml)", "파리제로(벽걸이)",
  "전입기사", "사무실(비육3팀)", "코보정기",
];

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

async function loadGroups(s) {
  const data = await s.get(GROUPS_KEY, { type: "json" });
  return data || [];
}

async function loadLimits(s) {
  const data = await s.get(LIMITS_KEY, { type: "json" });
  return data || [];
}

async function loadExcludedItems(s) {
  const data = await s.get(EXCLUDED_KEY, { type: "json" });
  return data || DEFAULT_EXCLUDED_ITEMS;
}

export default async (req, context) => {
  const s = store();

  if (req.method === "GET") {
    const [groups, limits, excludedItems] = await Promise.all([loadGroups(s), loadLimits(s), loadExcludedItems(s)]);
    return json({ groups, limits, excludedItems });
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

    if (action === "saveGroups") {
      // 그룹은 이름만 전역으로 관리 (소속 농가는 월별 한도 항목에서 관리)
      const groups = Array.isArray(body.groups) ? body.groups : [];
      const cleaned = groups
        .map((g) => ({ name: (typeof g === "string" ? g : g.name || "").trim() }))
        .filter((g) => g.name);
      await s.setJSON(GROUPS_KEY, cleaned);
      return json({ ok: true, groups: cleaned });
    }

    if (action === "saveLimit") {
      const { 구분월, 그룹, 전입두수, 한도금액, farms } = body;
      if (!구분월 || !그룹) return json({ error: "구분월, 그룹 required" }, 400);
      const limits = await loadLimits(s);
      const idx = limits.findIndex((l) => l.구분월 === 구분월 && l.그룹 === 그룹);
      const entry = {
        구분월,
        그룹,
        전입두수: Number(전입두수) || 0,
        한도금액: Number(한도금액) || 0,
        farms: Array.isArray(farms) ? farms.map((f) => (f || "").trim()).filter(Boolean) : [],
        수정자: editor || "",
        수정시각: now,
      };
      if (idx > -1) limits[idx] = entry;
      else limits.push(entry);
      await s.setJSON(LIMITS_KEY, limits);
      return json({ ok: true, entry });
    }

    if (action === "saveExcludedItems") {
      // 약품비 집계에서 항상 제외할 품목명 목록(소모품 등). 화면에서 직접 추가/삭제 가능.
      const items = Array.isArray(body.items) ? body.items : [];
      const cleaned = [...new Set(items.map((v) => (v || "").trim()).filter(Boolean))];
      await s.setJSON(EXCLUDED_KEY, cleaned);
      return json({ ok: true, excludedItems: cleaned });
    }

    if (action === "deleteLimit") {
      const { 구분월, 그룹 } = body;
      let limits = await loadLimits(s);
      limits = limits.filter((l) => !(l.구분월 === 구분월 && l.그룹 === 그룹));
      await s.setJSON(LIMITS_KEY, limits);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: "/api/medicine-groups",
};
