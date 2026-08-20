import { getStore } from "@netlify/blobs";

const STORE_NAME = "medicine-costs";
const TX_KEY = "records";
const BUDGET_KEY = "budgets";

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
  const data = await s.get(TX_KEY, { type: "json" });
  return data || [];
}

async function loadBudgets(s) {
  const data = await s.get(BUDGET_KEY, { type: "json" });
  return data || [];
}

export default async (req, context) => {
  const s = store();

  if (req.method === "GET") {
    const [transactions, budgets] = await Promise.all([loadRecords(s), loadBudgets(s)]);
    return json({ transactions, budgets });
  }

  if (req.method === "POST") {
    if (!checkAuth(req)) return json({ error: "unauthorized" }, 401);

    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json body" }, 400);
    }

    const { month, rows, budgetGroups, editor } = body;
    if (!month || !Array.isArray(rows)) {
      return json({ error: "month and rows[] required" }, 400);
    }

    const existingTx = await loadRecords(s);
    const keptTx = existingTx.filter((r) => r.구분월 !== month);

    const now = new Date().toISOString();
    const uploadedTx = rows.map((r, i) => ({
      id: `${month}-${i + 1}`,
      구분월: month,
      주문일자: r.주문일자 || "",
      납품일자: r.납품일자 || "",
      거래처: r.거래처 || "",
      농가명: r.농가명 || "",
      처방접수: r.처방접수 || "",
      약품명: r.약품명 || "",
      제제: r.제제 || "",
      제조사: r.제조사 || "",
      규격: r.규격 || "",
      수량: r.수량 || 0,
      구매처: r.구매처 || "",
      납품단가: r.납품단가 || 0,
      납품금액: r.납품금액 || 0,
      비고: r.비고 || "",
      담당자: r.담당자 || "",
      구분: r.구분 || "",
      구분1: r.구분1 || "",
      돈군구분: r.돈군구분 || "",
      업로드시각: now,
      업로드자: editor || "",
    }));
    const mergedTx = [...keptTx, ...uploadedTx];
    await s.setJSON(TX_KEY, mergedTx);

    let mergedBudgets = await loadBudgets(s);
    if (Array.isArray(budgetGroups) && budgetGroups.length) {
      mergedBudgets = mergedBudgets.filter((b) => b.구분월 !== month);
      const uploadedBudgets = budgetGroups.map((g) => ({
        구분월: month,
        그룹: g.그룹 || "",
        전입두수: g.전입두수 || 0,
        한도금액: g.한도금액 || 0,
        사용금액: g.사용금액 || 0,
        잔여한도: g.잔여한도 !== undefined ? g.잔여한도 : (g.한도금액 || 0) - (g.사용금액 || 0),
        업로드시각: now,
        업로드자: editor || "",
      }));
      mergedBudgets = [...mergedBudgets, ...uploadedBudgets];
      await s.setJSON(BUDGET_KEY, mergedBudgets);
    }

    return json({
      ok: true,
      month,
      count: uploadedTx.length,
      total: mergedTx.length,
      budgetGroups: budgetGroups ? budgetGroups.length : 0,
    });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: "/api/medicine",
};
