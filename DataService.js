/**
 * DataService.gs — 資料存取層（DAO）
 * 職責：統一讀取 Sheet 1–5，所有資料存取僅透過此模組
 * 
 * 設計原則：
 * - 本層只做「讀取」，不含業務邏輯
 * - 使用 CacheService 對 org / roleMap 快取（TTL 10 分鐘）
 * - 每個 get* 函式都返回 Plain Object Array，不暴露 Sheet 物件
 */

// =============================================
// 快取設定
// =============================================

/** @const {number} CacheService TTL（秒），10 分鐘 */
const CACHE_TTL_SEC = 600;

/** @const {Object} 快取 Key */
const CACHE_KEYS = {
  ORG:      'ds_org_all',
  ROLE_MAP: 'ds_rolemap',
};

// =============================================
// Sheet 1：人員主檔
// =============================================

/**
 * 取得所有人員資料
 * 
 * @returns {Array<{email, name, status}>}
 */
function getSheet1Data() {
  const rows = getSheetRows(SHEET_NAMES.PERSONNEL);
  return rows.map(rowToPersonnel);
}

/**
 * 依 Email 查找單一人員
 * 提取為獨立函式供 AuthService 使用，避免重複讀取整表
 * 
 * @param {string} email
 * @returns {Object|null}
 */
function findPersonByEmail(email) {
  const all = getSheet1Data();
  return all.find(p => p.email === email) || null;
}

/**
 * 將 Sheet 1 的一列資料轉為 Object
 * 提取此 mapper 讓 getSheet1Data 保持簡潔
 * 
 * @param {Array} row
 * @returns {Object}
 */
function rowToPersonnel(row) {
  return {
    email:  row[COL.PERSONNEL.EMAIL],
    name:   row[COL.PERSONNEL.NAME],
    status: normalizePersonnelStatus(row[COL.PERSONNEL.STATUS]),
  };
}

function normalizePersonnelStatus(rawStatus) {
  return PERSONNEL_STATUSES.has(rawStatus) ? rawStatus : '在職';
}

// =============================================
// Sheet 2：組織架構樹
// =============================================

/**
 * 取得組織架構資料，支援依 orgType 篩選
 * 使用 CacheService 快取以降低 Sheets API 呼叫次數
 * 
 * @param {string|null} orgType - 'ORG'|'TF'|'PARTNER'|'GOV'|null（null=全部）
 * @returns {Array<{type, level, code, name, alias, parentCode, managerEmail, managerName}>}
 */
function getSheet2Data(orgType) {
  const allOrg = getCachedOrgData();
  if (!orgType) return allOrg;
  return allOrg.filter(o => o.type === orgType);
}

/**
 * 依代碼查找組織節點
 * 
 * @param {string} code
 * @returns {Object|null}
 */
function findOrgByCode(code) {
  const all = getCachedOrgData();
  return all.find(o => o.code === code) || null;
}

/**
 * 從快取取得組織資料，快取不存在時重新讀取
 * 
 * @returns {Array}
 */
function getCachedOrgData() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.ORG);
  if (cached) return JSON.parse(cached);

  const rows = getSheetRows(SHEET_NAMES.ORG);
  const data = rows.map(rowToOrg);
  cache.put(CACHE_KEYS.ORG, JSON.stringify(data), CACHE_TTL_SEC);
  return data;
}

function rowToOrg(row) {
  return {
    type:         row[COL.ORG.TYPE],
    level:        Number(row[COL.ORG.LEVEL]),
    code:         row[COL.ORG.CODE],
    name:         row[COL.ORG.NAME],
    alias:        row[COL.ORG.ALIAS] || '',
    parentCode:   row[COL.ORG.PARENT_CODE] || '',
    managerEmail: row[COL.ORG.MANAGER_EMAIL] || '',
    managerName:  row[COL.ORG.MANAGER_NAME] || '',
  };
}

// =============================================
// Sheet 3：人員職務配置
// =============================================

/**
 * 依 Email 取得人員所有職務配置
 * 
 * @param {string} email
 * @returns {Array<{email, name, orgCode, orgName, title, managerEmail, managerName, rowIndex}>}
 */
function getSheet3DataByEmail(email) {
  const all = getAllAssignments();
  return all.filter(a => a.email === email);
}

/**
 * 依組別代碼取得所有成員職務配置
 * 
 * @param {string} code
 * @returns {Array}
 */
function getSheet3DataByOrgCode(code) {
  const all = getAllAssignments();
  return all.filter(a => a.orgCode === code);
}

/**
 * 查詢此 Email 是否有人以其為直屬主管（判斷是否為主管角色）
 * 
 * @param {string} email
 * @returns {boolean}
 */
function hasDirectReport(email) {
  const all = getAllAssignments();
  return all.some(a => a.managerEmail === email);
}

/**
 * 取得所有職務配置（含 rowIndex 供後續 update/delete 使用）
 * 
 * @returns {Array}
 */
function getAllAssignments() {
  const sheet = getSheet(SHEET_NAMES.ASSIGNMENT);
  const data = sheet.getDataRange().getValues();
  // 第 1 列為標題，從第 2 列（index=1）開始，rowIndex 為試算表實際列號（從 1 計）
  return data.slice(1).map((row, idx) => rowToAssignment(row, idx + 2));
}

function rowToAssignment(row, rowIndex) {
  return {
    email:        row[COL.ASSIGNMENT.EMAIL],
    name:         row[COL.ASSIGNMENT.NAME],
    orgCode:      row[COL.ASSIGNMENT.ORG_CODE],
    orgName:      row[COL.ASSIGNMENT.ORG_NAME],
    title:        row[COL.ASSIGNMENT.TITLE],
    managerEmail: row[COL.ASSIGNMENT.MANAGER_EMAIL] || '',
    managerName:  row[COL.ASSIGNMENT.MANAGER_NAME] || '',
    rowIndex,
  };
}

/**
 * findAssignmentsByEmail 供 AuthService 使用的別名（維持命名一致性）
 */
function findAssignmentsByEmail(email) {
  return getSheet3DataByEmail(email);
}

// =============================================
// Sheet 4：RACI 矩陣主表
// =============================================

/**
 * 取得 RACI 主表，支援依任務代碼篩選
 * 
 * @param {string|null} taskCode - null 表示全部
 * @returns {Array<{taskCode, taskName, itemCode, itemName, R, A, C, I, note}>}
 */
function getSheet4Data(taskCode) {
  const rows = getSheetRows(SHEET_NAMES.RACI);
  const all = rows.map(rowToRaci);
  if (!taskCode) return all;
  return all.filter(r => r.taskCode === taskCode);
}

function rowToRaci(row) {
  return {
    taskCode: row[COL.RACI.TASK_CODE],
    taskName: row[COL.RACI.TASK_NAME],
    itemCode: row[COL.RACI.ITEM_CODE],
    itemName: row[COL.RACI.ITEM_NAME],
    R:        row[COL.RACI.R] || '',
    A:        row[COL.RACI.A] || '',
    C:        row[COL.RACI.C] || '',
    I:        row[COL.RACI.I] || '',
    note:     row[COL.RACI.NOTE] || '',
  };
}

// =============================================
// Sheet 5：角色對照表
// =============================================

/**
 * 取得完整角色對照表，使用 CacheService 快取
 * 
 * @returns {Array<{roleCode, roleName, entityType, entityId, description}>}
 */
function getSheet5Data() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEYS.ROLE_MAP);
  if (cached) return JSON.parse(cached);

  const rows = getSheetRows(SHEET_NAMES.ROLE_MAP);
  const data = rows.map(rowToRoleMap);
  cache.put(CACHE_KEYS.ROLE_MAP, JSON.stringify(data), CACHE_TTL_SEC);
  return data;
}

function rowToRoleMap(row) {
  return normalizeRoleMapRow(row);
}

/**
 * 依角色代碼查找角色定義
 * 
 * @param {string} roleCode
 * @returns {Object|null}
 */
function findRoleByCode(roleCode) {
  const all = getSheet5Data();
  return all.find(r => r.roleCode === roleCode) || null;
}

/**
 * 依角色代碼取得所有角色定義列
 *
 * @param {string} roleCode
 * @returns {Array<Object>}
 */
function findRolesByCode(roleCode) {
  return getSheet5Data().filter(r => r.roleCode === roleCode);
}

// =============================================
// 寫入操作：人員主檔 (Sheet 1)
// =============================================

/**
 * 新增人員至 Sheet 1
 * 
 * @param {{email, name, status}} personObj
 */
function appendPersonnel(personObj) {
  const sheet = getSheet(SHEET_NAMES.PERSONNEL);
  sheet.appendRow([
    personObj.email,
    personObj.name,
    normalizePersonnelStatus(personObj.status),
  ]);
}

/**
 * 更新 Sheet 1 中指定 Email 的人員資料
 * 
 * @param {string} email
 * @param {Object} personObj
 * @returns {boolean} 是否找到並更新
 */
function updatePersonnelByEmail(email, personObj) {
  const sheet = getSheet(SHEET_NAMES.PERSONNEL);
  const data = sheet.getDataRange().getValues();

  // 從第 2 列開始搜尋（第 1 列為標題）
  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.PERSONNEL.EMAIL] !== email) continue;
    const rowNum = i + 1;
    sheet.getRange(rowNum, 1, 1, widthFromColMap(COL.PERSONNEL)).setValues([[
      personObj.email,
      personObj.name,
      normalizePersonnelStatus(personObj.status),
    ]]);
    return true;
  }
  return false;
}

/**
 * 刪除 Sheet 1 中指定 Email 的人員
 * 
 * @param {string} email
 * @returns {boolean}
 */
function deletePersonnelByEmail(email) {
  const sheet = getSheet(SHEET_NAMES.PERSONNEL);
  const data = sheet.getDataRange().getValues();

  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][COL.PERSONNEL.EMAIL] !== email) continue;
    sheet.deleteRow(i + 1);
    return true;
  }
  return false;
}

// =============================================
// 寫入操作：職務配置 (Sheet 3)
// =============================================

/**
 * 新增職務配置至 Sheet 3
 * 
 * @param {{email, name, orgCode, orgName, title, managerEmail, managerName}} assignObj
 */
function appendAssignment(assignObj) {
  const sheet = getSheet(SHEET_NAMES.ASSIGNMENT);
  sheet.appendRow([
    assignObj.email,
    assignObj.name,
    assignObj.orgCode,
    assignObj.orgName,
    assignObj.title,
    assignObj.managerEmail || '',
    assignObj.managerName  || '',
  ]);
}

/**
 * 更新 Sheet 3 指定列
 * 
 * @param {number} rowIndex - 試算表實際列號（從 1 計）
 * @param {Object} assignObj
 */
function updateAssignmentByRow(rowIndex, assignObj) {
  const sheet = getSheet(SHEET_NAMES.ASSIGNMENT);
  sheet.getRange(rowIndex, 1, 1, widthFromColMap(COL.ASSIGNMENT)).setValues([[
    assignObj.email,
    assignObj.name,
    assignObj.orgCode,
    assignObj.orgName,
    assignObj.title,
    assignObj.managerEmail || '',
    assignObj.managerName  || '',
  ]]);
}

/**
 * 刪除 Sheet 3 指定列
 * 
 * @param {number} rowIndex
 */
function deleteAssignmentByRow(rowIndex) {
  getSheet(SHEET_NAMES.ASSIGNMENT).deleteRow(rowIndex);
}

// =============================================
// 寫入操作：組織架構 (Sheet 2)
// =============================================

function appendOrgNode(nodeObj) {
  const sheet = getSheet(SHEET_NAMES.ORG);
  sheet.appendRow([
    nodeObj.type,
    nodeObj.level,
    nodeObj.code,
    nodeObj.name,
    nodeObj.alias        || '',
    nodeObj.parentCode   || '',
    nodeObj.managerEmail || '',
    nodeObj.managerName  || '',
  ]);
  invalidateOrgCache();
}

function updateOrgNodeByCode(code, nodeObj) {
  const sheet = getSheet(SHEET_NAMES.ORG);
  const data = sheet.getDataRange().getValues();

  for (let i = 1; i < data.length; i++) {
    if (data[i][COL.ORG.CODE] !== code) continue;
    sheet.getRange(i + 1, 1, 1, widthFromColMap(COL.ORG)).setValues([[
      nodeObj.type,
      nodeObj.level,
      nodeObj.code,
      nodeObj.name,
      nodeObj.alias        || '',
      nodeObj.parentCode   || '',
      nodeObj.managerEmail || '',
      nodeObj.managerName  || '',
    ]]);
    invalidateOrgCache();
    return true;
  }
  return false;
}

/** 強制清除組織快取（資料異動後呼叫） */
function invalidateOrgCache() {
  CacheService.getScriptCache().remove(CACHE_KEYS.ORG);
}

// =============================================
// 操作日誌
// =============================================

/**
 * 寫入操作日誌至「操作日誌」工作表
 * 
 * @param {string} action  - 操作類型（ADD / UPDATE / DELETE）
 * @param {string} target  - 操作對象描述（例如 "人員: abc@org"）
 * @param {string} details - 異動欄位摘要
 */
function appendAuditLog(action, target, details) {
  try {
    const email = Session.getActiveUser().getEmail();
    const sheet = getSheet(SHEET_NAMES.AUDIT_LOG);
    sheet.appendRow([
      new Date(),
      email,
      action,
      target,
      details,
    ]);
  } catch (e) {
    Logger.log('寫入操作日誌失敗：' + e.message);
    // 日誌寫入失敗不中斷主流程
  }
}

/**
 * 取得最近 N 筆操作日誌
 * 
 * @param {number} n
 * @returns {Array}
 */
function getRecentAuditLogs(n) {
  const sheet = getSheet(SHEET_NAMES.AUDIT_LOG);
  const data = sheet.getDataRange().getValues();
  const rows = data.slice(1); // 去掉標題列
  const recent = rows.slice(-n).reverse(); // 取最後 n 筆，倒序
  return recent.map(row => ({
    timestamp: row[COL.AUDIT_LOG.TIMESTAMP],
    operator:  row[COL.AUDIT_LOG.OPERATOR_EMAIL],
    action:    row[COL.AUDIT_LOG.ACTION],
    target:    row[COL.AUDIT_LOG.TARGET],
    details:   row[COL.AUDIT_LOG.DETAILS],
  }));
}

// =============================================
// 底層輔助：讀取工作表資料
// =============================================

/**
 * 讀取指定工作表的所有資料列（去除標題列）
 * 
 * 提取此函式以避免每個 get* 函式重複相同的讀取邏輯
 * @param {string} sheetName
 * @returns {Array<Array>} 不含標題的資料列陣列
 */
function getSheetRows(sheetName) {
  const sheet = getSheet(sheetName);
  const data = sheet.getDataRange().getValues();
  return data.slice(1); // 第 1 列為欄位標題
}

/**
 * GAS 檔案層級函式預設是全域函式，不會自動形成命名空間物件。
 * 補上 DataService namespace，讓其他檔案可用 DataService.xxx 呼叫。
 */
const DataService = {
  getSheet1Data,
  findPersonByEmail,
  findRolesByCode,
  getSheet2Data,
  findOrgByCode,
  getSheet3DataByEmail,
  getSheet3DataByOrgCode,
  hasDirectReport,
  getAllAssignments,
  findAssignmentsByEmail,
  getSheet4Data,
  getSheet5Data,
  findRoleByCode,
  appendPersonnel,
  updatePersonnelByEmail,
  deletePersonnelByEmail,
  appendAssignment,
  updateAssignmentByRow,
  deleteAssignmentByRow,
  appendOrgNode,
  updateOrgNodeByCode,
  appendAuditLog,
  getRecentAuditLogs,
};
