import { getStore } from "@netlify/blobs";

const STORE_NAME = "rearing-data";
const GROUPS_KEY = "groups";
const MORTALITY_KEY = "mortality";
const SNAPSHOTS_KEY = "snapshots";
const FARM_MANAGERS_KEY = "farm-managers";
const DIAGNOSIS_IMAGE_STORE_NAME = "rearing-diagnosis-images";
const FOCUS_LOG_IMAGE_STORE_NAME = "rearing-focus-log-images";

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function diagnosisImageStore() {
  return getStore({ name: DIAGNOSIS_IMAGE_STORE_NAME, consistency: "strong" });
}

function focusLogImageStore() {
  return getStore({ name: FOCUS_LOG_IMAGE_STORE_NAME, consistency: "strong" });
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

async function loadMortality(s) {
  const data = await s.get(MORTALITY_KEY, { type: "json" });
  return data || [];
}

async function loadSnapshots(s) {
  const data = await s.get(SNAPSHOTS_KEY, { type: "json" });
  return data || [];
}

// 사육그룹은 그룹 단위지만 담당자는 농장 단위 속성이라 그룹 레코드와 분리된 별도 맵({농장명: 담당자})으로 관리
async function loadFarmManagers(s) {
  const data = await s.get(FARM_MANAGERS_KEY, { type: "json" });
  return data || {};
}

const GROUP_FIELDS = [
  "플랜트", "농장명", "그룹명", "저장위치", "돼지구분", "전입일", "전입두수", "전입일령",
  "두당체중", "최초두수", "클레임", "현재일령", "폐사두수", "전출두수", "판매두수",
  "현재고", "육성률", "번식농장명", "자돈농장명", "자재코드", "자재명",
];

const SNAPSHOT_FIELDS = ["농장명", "그룹명", "저장위치", "전입두수", "최초두수", "폐사두수", "현재고", "육성률"];

// 폐사내역 파일에 그룹명/농장명/일령이 이미 직접 포함되어 있으므로,
// 저장위치·날짜로 배치를 추측 매칭하던 이전 로직은 전부 제거하고 파일 값을 그대로 사용한다.
const MORTALITY_FIELDS = [
  "플랜트", "농장명", "그룹명", "저장위치", "돼지구분", "폐사발생일", "폐사두수", "원인", "사망일령",
];

function normKeyPart(v) {
  return (v === undefined || v === null ? "" : String(v)).trim().toUpperCase();
}

function mortalityKey(r) {
  return [normKeyPart(r.플랜트), normKeyPart(r.그룹명), normKeyPart(r.폐사발생일), normKeyPart(r.폐사두수), normKeyPart(r.원인)].join("|");
}

// 그룹명 앞뒤 공백/대소문자 차이로 같은 그룹이 다른 그룹으로 인식되어 중복 저장되는 문제 방지용 정규화 키
function groupKey(v) {
  return normKeyPart(v);
}

function monthBucket(ageDays) {
  if (ageDays === null || ageDays === undefined || ageDays === "") return "";
  const n = Number(ageDays);
  if (isNaN(n)) return "";
  if (n <= 120) return "4개월령";
  if (n <= 150) return "5개월령";
  if (n <= 180) return "6개월령";
  return "7개월령";
}

export default async (req, context) => {
  const s = store();

  if (req.method === "GET") {
    const url = new URL(req.url);
    const imgKey = url.searchParams.get("image");
    if (imgKey) {
      const kind = url.searchParams.get("kind") || "diag";
      const imgStore = kind === "focus" ? focusLogImageStore() : diagnosisImageStore();
      const result = await imgStore.getWithMetadata(imgKey, { type: "arrayBuffer" });
      if (!result || !result.data) return new Response("Not found", { status: 404 });
      const contentType = (result.metadata && result.metadata.contentType) || "application/octet-stream";
      return new Response(result.data, {
        status: 200,
        headers: { "content-type": contentType, "cache-control": "public, max-age=31536000, immutable" },
      });
    }
    const [groups, mortality, snapshots, farmManagers] = await Promise.all([loadGroups(s), loadMortality(s), loadSnapshots(s), loadFarmManagers(s)]);
    return json({ groups, mortality, snapshots, farmManagers });
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
    const thisMonth = now.slice(0, 7);

    if (action === "uploadGroups") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const groups = await loadGroups(s);
      const snapshots = await loadSnapshots(s);
      let added = 0, updated = 0;
      for (const row of rows) {
        if (!row.그룹명) continue;
        const rowKey = groupKey(row.그룹명);
        const idx = groups.findIndex((g) => groupKey(g.그룹명) === rowKey);
        // 신규 등록 시에는 모든 필드를 채우되(값 없으면 빈 문자열), 기존 그룹 갱신 시에는
        // 업로드 파일에 실제로 들어있는 필드만 덮어쓴다. 파일 서식이 바뀌어 일부 컬럼(예: 전입일령,
        // 번식농장명 등)이 빠져도 이미 저장돼 있던 값을 빈 문자열로 지워버리지 않기 위함.
        const cleanForNew = {};
        GROUP_FIELDS.forEach((f) => { cleanForNew[f] = row[f] !== undefined ? row[f] : ""; });
        const cleanForUpdate = {};
        GROUP_FIELDS.forEach((f) => { if (row[f] !== undefined) cleanForUpdate[f] = row[f]; });
        if (idx > -1) {
          groups[idx] = { ...groups[idx], ...cleanForUpdate, 수정자: editor || "", 수정시각: now };
          updated++;
        } else {
          groups.push({ ...cleanForNew, 상태: "사육중", 등록자: editor || "", 등록시각: now, 수정자: editor || "", 수정시각: now });
          added++;
        }
        const savedGroup = idx > -1 ? groups[idx] : groups[groups.length - 1];
        // 이번 달 스냅샷 저장(같은 달에 여러 번 올리면 최신 값으로 갱신) - 갱신 후의 전체 값 기준
        const sIdx = snapshots.findIndex((sn) => sn.연월 === thisMonth && groupKey(sn.그룹명) === rowKey);
        const snap = { 연월: thisMonth, 스냅샷시각: now };
        SNAPSHOT_FIELDS.forEach((f) => { snap[f] = savedGroup[f] !== undefined ? savedGroup[f] : ""; });
        if (sIdx > -1) snapshots[sIdx] = snap;
        else snapshots.push(snap);
      }
      await s.setJSON(GROUPS_KEY, groups);
      await s.setJSON(SNAPSHOTS_KEY, snapshots);
      return json({ ok: true, added, updated, total: groups.length });
    }

    if (action === "setFarmManager") {
      const { 농장명, 담당자 } = body;
      if (!농장명) return json({ error: "농장명 required" }, 400);
      const managers = await loadFarmManagers(s);
      if (담당자 && String(담당자).trim()) managers[농장명] = String(담당자).trim();
      else delete managers[농장명];
      await s.setJSON(FARM_MANAGERS_KEY, managers);
      return json({ ok: true, farmManagers: managers });
    }

    if (action === "clearGroups") {
      // 사육그룹내역(비육/후기자돈 전체)을 완전히 비운다. 업로드 파일 서식을 바꾸면서
      // 이전 서식으로 올려둔 그룹 데이터를 전부 지우고 새 파일로 다시 올리기 위한 용도.
      const groups = await loadGroups(s);
      const removed = groups.length;
      await s.setJSON(GROUPS_KEY, []);
      return json({ ok: true, removed });
    }

    if (action === "dedupeGroups") {
      // 그룹명 앞뒤 공백/대소문자 차이로 예전에 중복 저장된 그룹들을 정리.
      // 같은 정규화 키를 가진 그룹 중 가장 최근에 수정된 것만 남긴다.
      const groups = await loadGroups(s);
      const byKey = new Map();
      for (const g of groups) {
        const key = groupKey(g.그룹명);
        if (!key) continue;
        const existing = byKey.get(key);
        if (!existing) { byKey.set(key, g); continue; }
        const existingTime = existing.수정시각 || existing.등록시각 || "";
        const currentTime = g.수정시각 || g.등록시각 || "";
        if (currentTime >= existingTime) byKey.set(key, g);
      }
      const kept = [...byKey.values()];
      const removed = groups.length - kept.length;
      await s.setJSON(GROUPS_KEY, kept);
      return json({ ok: true, removed, total: kept.length });
    }

    if (action === "setGroupStatus") {
      const { 그룹명, 상태 } = body;
      if (!그룹명 || !상태) return json({ error: "그룹명, 상태 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => g.그룹명 === 그룹명);
      if (idx === -1) return json({ error: "not found" }, 404);
      groups[idx] = { ...groups[idx], 상태, 수정자: editor || "", 수정시각: now };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "setGroupSettlement") {
      // 정산예정월: ''(정산예정 아님) 또는 'YYYY-MM'(당월/다음달/그다음달 중 선택된 실제 월).
      // 정산예정(boolean)은 하위호환을 위해 정산예정월 유무로 함께 갱신.
      const { 그룹명, 정산예정월, 정산예정 } = body;
      if (!그룹명) return json({ error: "그룹명 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      const monthValue = 정산예정월 !== undefined ? (정산예정월 || "") : (정산예정 ? groups[idx].정산예정월 || "" : "");
      groups[idx] = {
        ...groups[idx],
        정산예정월: monthValue,
        정산예정: !!monthValue,
        수정자: editor || "",
        수정시각: now,
      };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "setGroupSettlementComplete") {
      const { 그룹명, 정산완료 } = body;
      if (!그룹명) return json({ error: "그룹명 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      groups[idx] = { ...groups[idx], 정산완료: !!정산완료, 정산완료시각: 정산완료 ? now : "", 수정자: editor || "", 수정시각: now };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "setGroupFocusManagement") {
      const { 그룹명, 집중관리 } = body;
      if (!그룹명) return json({ error: "그룹명 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      groups[idx] = { ...groups[idx], 집중관리: !!집중관리, 수정자: editor || "", 수정시각: now };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "addFocusActionLog") {
      const { 그룹명, 담당자, 내용 } = body;
      if (!그룹명 || !내용) return json({ error: "그룹명, 내용 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      const entry = { 날짜: now.slice(0, 10), 담당자: 담당자 || "", 내용, 등록시각: now };
      const history = Array.isArray(groups[idx].조치사항이력) ? groups[idx].조치사항이력 : [];
      history.push(entry);
      groups[idx] = { ...groups[idx], 조치사항이력: history };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "editFocusActionLog") {
      const { 그룹명, index, 담당자, 내용 } = body;
      if (!그룹명 || index === undefined || index === null || !내용) return json({ error: "그룹명, index, 내용 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      const history = Array.isArray(groups[idx].조치사항이력) ? groups[idx].조치사항이력.slice() : [];
      const i = Number(index);
      if (!(i >= 0 && i < history.length)) return json({ error: "invalid index" }, 400);
      history[i] = { ...history[i], 담당자: 담당자 || "", 내용, 수정시각: now };
      groups[idx] = { ...groups[idx], 조치사항이력: history };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "deleteFocusActionLog") {
      // 조치사항 이력 한 건 삭제. 거기 딸린 이미지가 있으면 Blobs에서도 함께 지운다.
      const { 그룹명, index } = body;
      if (!그룹명 || index === undefined || index === null) return json({ error: "그룹명, index required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      const history = Array.isArray(groups[idx].조치사항이력) ? groups[idx].조치사항이력.slice() : [];
      const i = Number(index);
      if (!(i >= 0 && i < history.length)) return json({ error: "invalid index" }, 400);
      const removedImages = Array.isArray(history[i].이미지목록) ? history[i].이미지목록 : [];
      await Promise.all(removedImages.map((im) => focusLogImageStore().delete(im.key).catch(() => {})));
      history.splice(i, 1);
      groups[idx] = { ...groups[idx], 조치사항이력: history };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "uploadFocusLogImage") {
      // 집중관리 조치사항(활동내역) 이미지: base64로 받아 별도 Blobs store(바이너리)에 저장하고,
      // 해당 조치사항 이력 항목의 이미지목록 배열에 참조(key/파일명/업로드정보)만 남긴다.
      const { 그룹명, index, 파일명, contentType, dataBase64 } = body;
      if (!그룹명 || index === undefined || index === null || !dataBase64) {
        return json({ error: "그룹명, index, dataBase64 required" }, 400);
      }
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      const history = Array.isArray(groups[idx].조치사항이력) ? groups[idx].조치사항이력.slice() : [];
      const i = Number(index);
      if (!(i >= 0 && i < history.length)) return json({ error: "invalid index" }, 400);

      let buf;
      try {
        buf = Buffer.from(dataBase64, "base64");
      } catch {
        return json({ error: "invalid dataBase64" }, 400);
      }

      const key = `${groupKey(그룹명)}-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await focusLogImageStore().set(key, buf, {
        metadata: { contentType: contentType || "application/octet-stream", 파일명: 파일명 || "" },
      });

      const images = Array.isArray(history[i].이미지목록) ? history[i].이미지목록.slice() : [];
      images.push({ key, 파일명: 파일명 || "", 업로드자: editor || "", 업로드시각: now });
      history[i] = { ...history[i], 이미지목록: images };
      groups[idx] = { ...groups[idx], 조치사항이력: history };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "deleteFocusLogImage") {
      const { 그룹명, index, key } = body;
      if (!그룹명 || index === undefined || index === null || !key) return json({ error: "그룹명, index, key required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      const history = Array.isArray(groups[idx].조치사항이력) ? groups[idx].조치사항이력.slice() : [];
      const i = Number(index);
      if (!(i >= 0 && i < history.length)) return json({ error: "invalid index" }, 400);

      await focusLogImageStore().delete(key);

      const images = (Array.isArray(history[i].이미지목록) ? history[i].이미지목록 : []).filter((im) => im.key !== key);
      history[i] = { ...history[i], 이미지목록: images };
      groups[idx] = { ...groups[idx], 조치사항이력: history };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "saveGroupSurvivalReason") {
      const { 그룹명, 육성률사유 } = body;
      if (!그룹명) return json({ error: "그룹명 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      groups[idx] = { ...groups[idx], 육성률사유: 육성률사유 || "", 수정자: editor || "", 수정시각: now };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "saveGroupDiagnosis") {
      // 병성감정(질병 진단 결과) 텍스트를 표에서 바로 입력/수정
      const { 그룹명, 병성감정 } = body;
      if (!그룹명) return json({ error: "그룹명 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      groups[idx] = { ...groups[idx], 병성감정: 병성감정 || "", 수정자: editor || "", 수정시각: now };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "uploadDiagnosisImage") {
      // 병성 관리내역 이미지: base64로 받아 별도 Blobs store(바이너리)에 저장하고,
      // 그룹 레코드의 병성이미지목록 배열에 참조(key/파일명/업로드정보)만 남긴다.
      const { 그룹명, 파일명, contentType, dataBase64 } = body;
      if (!그룹명 || !dataBase64) return json({ error: "그룹명, dataBase64 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);

      let buf;
      try {
        buf = Buffer.from(dataBase64, "base64");
      } catch {
        return json({ error: "invalid dataBase64" }, 400);
      }

      const key = `${groupKey(그룹명)}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await diagnosisImageStore().set(key, buf, {
        metadata: { contentType: contentType || "application/octet-stream", 파일명: 파일명 || "" },
      });

      const images = Array.isArray(groups[idx].병성이미지목록) ? groups[idx].병성이미지목록.slice() : [];
      images.push({ key, 파일명: 파일명 || "", 업로드자: editor || "", 업로드시각: now });
      groups[idx] = { ...groups[idx], 병성이미지목록: images };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "deleteDiagnosisImage") {
      const { 그룹명, key } = body;
      if (!그룹명 || !key) return json({ error: "그룹명, key required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);

      await diagnosisImageStore().delete(key);

      const images = (Array.isArray(groups[idx].병성이미지목록) ? groups[idx].병성이미지목록 : []).filter((im) => im.key !== key);
      groups[idx] = { ...groups[idx], 병성이미지목록: images };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "deleteGroup") {
      const { 그룹명 } = body;
      if (!그룹명) return json({ error: "그룹명 required" }, 400);
      const groups = await loadGroups(s);
      const key = groupKey(그룹명);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === key);
      if (idx === -1) return json({ error: "not found" }, 404);
      groups.splice(idx, 1);
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true });
    }

    if (action === "logStockCheck") {
      // 재고 확인 이력 누적: 그룹별로 날짜+담당자를 계속 쌓아서 언제 누가 확인했는지 볼 수 있게 함
      const { 그룹명, 담당자, 날짜 } = body;
      if (!그룹명 || !담당자) return json({ error: "그룹명, 담당자 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      const entry = { 날짜: 날짜 || now.slice(0, 10), 담당자, 등록시각: now };
      const history = Array.isArray(groups[idx].재고확인이력) ? groups[idx].재고확인이력 : [];
      history.push(entry);
      groups[idx] = { ...groups[idx], 재고확인이력: history };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "saveGroupNote") {
      const { 그룹명, 특이사항, editor: noteEditor } = body;
      if (!그룹명) return json({ error: "그룹명 required" }, 400);
      const groups = await loadGroups(s);
      const idx = groups.findIndex((g) => groupKey(g.그룹명) === groupKey(그룹명));
      if (idx === -1) return json({ error: "not found" }, 404);
      groups[idx] = { ...groups[idx], 특이사항: 특이사항 || "", 특이사항수정자: noteEditor || editor || "", 특이사항수정시각: now };
      await s.setJSON(GROUPS_KEY, groups);
      return json({ ok: true, group: groups[idx] });
    }

    if (action === "uploadMortality") {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      const existing = await loadMortality(s);
      // 같은 업로드 파일 "안"의 행끼리는 서로 비교하지 않는다 (같은 그룹·날짜·두수·원인이어도
      // 서로 다른 실제 폐사 건일 수 있음). 오직 "이전에 이미 저장된" 기록과만 비교해서
      // 같은 파일을 통째로 재업로드했을 때만 중복으로 걸러낸다.
      const existingKeys = new Set(existing.map(mortalityKey));
      let added = 0, skipped = 0;
      const newOnes = [];
      for (const row of rows) {
        if (!row.폐사발생일 || !row.그룹명) continue;
        const clean = {};
        MORTALITY_FIELDS.forEach((f) => { clean[f] = row[f] !== undefined ? row[f] : ""; });
        clean.개월령 = monthBucket(clean.사망일령);
        const key = mortalityKey(clean);
        if (existingKeys.has(key)) { skipped++; continue; }

        newOnes.push({
          ...clean,
          id: 0,
          업로드자: editor || "",
          업로드시각: now,
        });
        added++;
      }
      let nextId = existing.length ? Math.max(...existing.map((r) => r.id || 0)) + 1 : 1;
      newOnes.forEach((r) => { r.id = nextId++; });
      const merged = [...existing, ...newOnes];
      await s.setJSON(MORTALITY_KEY, merged);
      return json({ ok: true, added, skipped, total: merged.length });
    }

    if (action === "dedupeMortality") {
      const existing = await loadMortality(s);
      const seen = new Set();
      const kept = [];
      let removed = 0;
      for (const r of existing) {
        const key = mortalityKey(r);
        if (seen.has(key)) { removed++; continue; }
        seen.add(key);
        kept.push(r);
      }
      await s.setJSON(MORTALITY_KEY, kept);
      return json({ ok: true, removed, total: kept.length });
    }

    if (action === "recomputeMortalityMatch") {
      // 예전 파일형식(위치/날짜로 배치 추측 매칭)으로 저장된 기록의 개월령만 다시 계산.
      // 그룹명/일령이 직접 포함된 새 형식으로 올린 기록은 이미 정확하므로 변화가 없다.
      const existing = await loadMortality(s);
      let changed = 0;
      const updated = existing.map((r) => {
        const 개월령 = monthBucket(r.사망일령);
        if (개월령 !== r.개월령) changed++;
        return { ...r, 개월령 };
      });
      await s.setJSON(MORTALITY_KEY, updated);
      return json({ ok: true, changed, total: updated.length });
    }

    if (action === "clearMortality") {
      const existing = await loadMortality(s);
      const removed = existing.length;
      await s.setJSON(MORTALITY_KEY, []);
      return json({ ok: true, removed });
    }

    return json({ error: "unknown action" }, 400);
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = {
  path: "/api/rearing",
};
