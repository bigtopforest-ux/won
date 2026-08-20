import { getStore } from "@netlify/blobs";

const STORE_NAME = "shipments-data";
const KEY = "records";
const PEOPLE_KEY = "people";
const WEEKPLAN_KEY = "weekplans";
const MONTHPLAN_KEY = "monthplans";
const FARMMAP_KEY = "farmmap";

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

async function loadRecords(s) {
  const data = await s.get(KEY, { type: "json" });
  return data || [];
}

async function loadPeople(s) {
  const data = await s.get(PEOPLE_KEY, { type: "json" });
  return data || ["신동영", "김영진", "이오름"];
}

async function loadWeekPlans(s) {
  const data = await s.get(WEEKPLAN_KEY, { type: "json" });
  return data || [];
}

async function loadMonthPlans(s) {
  const data = await s.get(MONTHPLAN_KEY, { type: "json" });
  return data || [];
}

async function loadFarmMap(s) {
  const data = await s.get(FARMMAP_KEY, { type: "json" });
  return data || [];
}

export default async (req, context) => {
  const s = store();
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.get("people") === "1") {
      const people = await loadPeople(s);
      return json({ people });
    }
    if (url.searchParams.get("weekplans") === "1") {
      const weekPlans = await loadWeekPlans(s);
      return json({ weekPlans });
    }
    if (url.searchParams.get("monthplans") === "1") {
      const monthPlans = await loadMonthPlans(s);
      return json({ monthPlans });
    }
    if (url.searchParams.get("farmmap") === "1") {
      const farmMap = await loadFarmMap(s);
      return json({ farmMap });
    }
    const data = await loadRecords(s);
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

    const { action, editor } = body;
    const now = new Date().toISOString();

    if (action === "savePeople") {
      const people = Array.isArray(body.people) ? body.people.map((p) => (p || "").trim()).filter(Boolean) : [];
      await s.setJSON(PEOPLE_KEY, people);
      return json({ ok: true, people });
    }

    if (action === "saveFarmMap") {
      const farmMap = Array.isArray(body.farmMap)
        ? body.farmMap.map((f) => ({ 농가명: (f.농가명 || "").trim(), 지역부장: (f.지역부장 || "").trim() })).filter((f) => f.농가명)
        : [];
      await s.setJSON(FARMMAP_KEY, farmMap);
      return json({ ok: true, farmMap });
    }

    if (action === "upsert") {
      const records = await loadRecords(s);
      const rec = body.record || {};
      const merged = { ...rec, 수정자: editor || "", 수정시각: now };

      // 농가-지역부장 매핑 자동 학습: 이번에 지정된 담당자를 다음 업로드에도 재사용
      if (merged.농가명 && merged.지역부장) {
        const farmMap = await loadFarmMap(s);
        const fIdx = farmMap.findIndex((f) => f.농가명 === merged.농가명);
        if (fIdx > -1) farmMap[fIdx].지역부장 = merged.지역부장;
        else farmMap.push({ 농가명: merged.농가명, 지역부장: merged.지역부장 });
        await s.setJSON(FARMMAP_KEY, farmMap);
      }

      if (rec.id) {
        const idx = records.findIndex((r) => r.id === rec.id);
        if (idx === -1) return json({ error: "not found" }, 404);
        records[idx] = { ...records[idx], ...merged };
        await s.setJSON(KEY, records);
        return json(records[idx]);
      } else {
        const newId = records.length ? Math.max(...records.map((r) => r.id)) + 1 : 1;
        merged.id = newId;
        merged.등록자 = editor || "";
        merged.등록시각 = now;
        records.push(merged);
        await s.setJSON(KEY, records);
        return json(merged, 201);
      }
    }

    if (action === "saveWeekPlan") {
      // 주간 계획은 거래처(일호/참푸른) 구분 없이 원료돈 계획두수 하나로 관리 (실적만 거래처별로 계속 표시됨)
      // 차주 예상물량은 일호식품/참푸른/기타(신선,위축) 3개 항목으로 나눠서 입력받고 합계를 차주예상두수로 저장
      const { 주차시작일, 지역부장, 계획두수, 차주예상일호, 차주예상참푸른, 차주예상기타 } = body;
      if (!주차시작일 || !지역부장) return json({ error: "주차시작일, 지역부장 required" }, 400);
      const plans = await loadWeekPlans(s);
      const idx = plans.findIndex((p) => p.주차시작일 === 주차시작일 && p.지역부장 === 지역부장);
      const 예상일호 = Number(차주예상일호) || 0;
      const 예상참푸른 = Number(차주예상참푸른) || 0;
      const 예상기타 = Number(차주예상기타) || 0;
      const entry = {
        주차시작일,
        지역부장,
        계획두수: Number(계획두수) || 0,
        차주예상일호: 예상일호,
        차주예상참푸른: 예상참푸른,
        차주예상기타: 예상기타,
        차주예상두수: 예상일호 + 예상참푸른 + 예상기타,
        수정자: editor || "",
        수정시각: now,
      };
      if (idx > -1) plans[idx] = { ...plans[idx], ...entry };
      else plans.push(entry);
      await s.setJSON(WEEKPLAN_KEY, plans);
      return json({ ok: true, entry });
    }

    if (action === "saveMonthPlan") {
      const { 연월, 지역부장, 계획일호, 계획참푸른, 계획기타 } = body;
      if (!연월 || !지역부장) return json({ error: "연월, 지역부장 required" }, 400);
      const plans = await loadMonthPlans(s);
      const idx = plans.findIndex((p) => p.연월 === 연월 && p.지역부장 === 지역부장);
      const 일호 = Number(계획일호) || 0;
      const 참푸른 = Number(계획참푸른) || 0;
      const 기타 = Number(계획기타) || 0;
      const entry = {
        연월,
        지역부장,
        계획일호: 일호,
        계획참푸른: 참푸른,
        계획기타: 기타,
        계획두수: 일호 + 참푸른 + 기타,
        수정자: editor || "",
        수정시각: now,
      };
      if (idx > -1) plans[idx] = { ...plans[idx], ...entry };
      else plans.push(entry);
      await s.setJSON(MONTHPLAN_KEY, plans);
      return json({ ok: true, entry });
    }

    if (action === "delete") {
      let records = await loadRecords(s);
      records = records.filter((r) => r.id !== body.id);
      await s.setJSON(KEY, records);
      return json({ ok: true });
    }

    return json({ error: "unknown action" }, 400);
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: "/api/shipments",
};
