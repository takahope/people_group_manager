/**
 * AuditAPI.gs — 稽核驗證 API
 * 職責：執行五大資料完整性驗證，回傳結構化稽核報告
 * 
 * 設計原則：
 * - 每個驗證項目獨立成一個函式（高內聚）
 * - runFullAudit 只做「彙總」，不重複實作驗證邏輯
 */

// =============================================
// 稽核嚴重度定義
// =============================================

const SEVERITY = {
  CRITICAL: 'Critical', // 違反 ISO 規範，必須立即修正
  WARNING:  'Warning',  // 資料異常，建議修正
  INFO:     'Info',     // 資訊提示
};

// =============================================
// 完整稽核（彙總執行器）
// =============================================

/**
 * 執行所有驗證項目，回傳結構化結果
 * 
 * 此函式只負責「呼叫各驗證函式並彙整結果」
 * 每項驗證的邏輯各自封裝，互不干擾
 * 
 * @returns {string} JSON 回應
 */
function runFullAudit() {
  try {
    if (!checkPermission('audit.run')) return errorResponse('無執行稽核驗證的權限');

    const checks = [
      { id: 'accountability_uniqueness', label: 'A 欄唯一性',    fn: _checkAccountabilityUniqueness },
      { id: 'role_code_exists',          label: '角色代碼存在性', fn: _checkRoleCodeExists },
      { id: 'person_foreign_key',        label: '人員外鍵完整性', fn: _checkPersonForeignKey },
      { id: 'org_foreign_key',           label: '組別外鍵完整性', fn: _checkOrgForeignKey },
      { id: 'manager_cycle',             label: '主管鏈無迴圈',   fn: _checkManagerCycle },
    ];

    const results = checks.map(({ id, label, fn }) => {
      try {
        const issues = fn();
        return {
          id,
          label,
          passed:    issues.length === 0,
          issueCount: issues.length,
          issues,
        };
      } catch (e) {
        return { id, label, passed: false, issueCount: -1, issues: [], error: e.message };
      }
    });

    const summary = {
      totalChecks:   results.length,
      passedChecks:  results.filter(r => r.passed).length,
      failedChecks:  results.filter(r => !r.passed).length,
      criticalCount: results.filter(r => !r.passed && isCritical(r.id)).length,
    };

    return successResponse({ summary, results });
  } catch (error) {
    return errorResponse(error.message);
  }
}

// =============================================
// 個別驗證函式（Public API 包裝）
// =============================================

/** 供前端直接呼叫 */
function checkAccountabilityUniqueness() {
  try {
    if (!checkPermission('audit.run')) return errorResponse('無權限');
    return successResponse(_checkAccountabilityUniqueness());
  } catch (e) { return errorResponse(e.message); }
}

function checkRoleCodeExists() {
  try {
    if (!checkPermission('audit.run')) return errorResponse('無權限');
    return successResponse(_checkRoleCodeExists());
  } catch (e) { return errorResponse(e.message); }
}

function checkPersonForeignKey() {
  try {
    if (!checkPermission('audit.run')) return errorResponse('無權限');
    return successResponse(_checkPersonForeignKey());
  } catch (e) { return errorResponse(e.message); }
}

function checkOrgForeignKey() {
  try {
    if (!checkPermission('audit.run')) return errorResponse('無權限');
    return successResponse(_checkOrgForeignKey());
  } catch (e) { return errorResponse(e.message); }
}

function checkManagerCycle() {
  try {
    if (!checkPermission('audit.run')) return errorResponse('無權限');
    return successResponse(_checkManagerCycle());
  } catch (e) { return errorResponse(e.message); }
}

// =============================================
// 驗證邏輯實作（Private，以底線前綴標示）
// =============================================

/**
 * 1. A 欄唯一性：Sheet 4 每個工作項目的 A 欄必須只有一個角色代碼
 * ISO 強制規定，違反為 Critical
 * 
 * @returns {Array<{itemCode, itemName, A, severity}>}
 */
function _checkAccountabilityUniqueness() {
  const raciData = DataService.getSheet4Data(null);
  return raciData
    .filter(item => hasMultipleRoles(item.A))
    .map(item => ({
      itemCode: item.itemCode,
      itemName: item.itemName,
      A:        item.A,
      severity: SEVERITY.CRITICAL,
      message:  `A 欄包含多個角色代碼（ISO 規定每個工作項目僅允許一個當責角色）`,
    }));
}

/**
 * 2. 角色代碼存在性：Sheet 4 的 R/A/C/I 每個代碼必須在 Sheet 5 找到對應
 * 
 * @returns {Array<{itemCode, invalidCodes, severity}>}
 */
function _checkRoleCodeExists() {
  const raciData = DataService.getSheet4Data(null);
  const validCodes = new Set(DataService.getSheet5Data().map(r => r.roleCode));
  const issues = [];

  raciData.forEach(item => {
    const allCodes = extractRoleCodes(item);
    const invalidCodes = allCodes.filter(code => code && !validCodes.has(code));

    if (invalidCodes.length > 0) {
      issues.push({
        itemCode:    item.itemCode,
        itemName:    item.itemName,
        invalidCodes,
        severity:    SEVERITY.WARNING,
        message:     `以下角色代碼在 Sheet 5 中找不到對應：${invalidCodes.join(', ')}`,
      });
    }
  });

  return issues;
}

/**
 * 3. 人員外鍵完整性：Sheet 5 中 PERSON 類型的 entityId 必須在 Sheet 1 存在
 * 
 * @returns {Array<{roleCode, entityId, severity}>}
 */
function _checkPersonForeignKey() {
  const roleMap = DataService.getSheet5Data();
  const validEmails = new Set(DataService.getSheet1Data().map(p => p.email));

  return roleMap
    .filter(role => isPersonEntity(role.entityId))
    .filter(role => !validEmails.has(role.entityId))
    .map(role => ({
      roleCode: role.roleCode,
      roleName: role.roleName,
      entityId: role.entityId,
      severity: SEVERITY.WARNING,
      message:  `人員 ${role.entityId} 在人員主檔中不存在`,
    }));
}

/**
 * 4. 組別外鍵完整性：Sheet 3 的所屬組別代碼必須在 Sheet 2 存在
 * 
 * @returns {Array<{email, orgCode, severity}>}
 */
function _checkOrgForeignKey() {
  const assignments = DataService.getAllAssignments();
  const validOrgCodes = new Set(DataService.getSheet2Data(null).map(o => o.code));

  return assignments
    .filter(a => !validOrgCodes.has(a.orgCode))
    .map(a => ({
      email:    a.email,
      name:     a.name,
      orgCode:  a.orgCode,
      rowIndex: a.rowIndex,
      severity: SEVERITY.WARNING,
      message:  `組別代碼 ${a.orgCode} 在組織架構表中不存在`,
    }));
}

/**
 * 5. 主管鏈無迴圈：使用 DFS 拓撲排序檢查是否有循環引用
 * 
 * 演算法說明：
 * - 建立有向圖：員工 → 主管
 * - 對每個節點執行 DFS，追蹤「當前路徑」中的節點
 * - 若在 DFS 中再次遇到路徑上的節點，即找到循環
 * 
 * @returns {Array<{cycle, severity}>}
 */
function _checkManagerCycle() {
  const assignments = DataService.getAllAssignments();

  // 建立 email → managerEmail 的 Map（可能一對多，取第一筆）
  const managerOf = new Map();
  assignments.forEach(a => {
    if (a.email && a.managerEmail && !managerOf.has(a.email)) {
      managerOf.set(a.email, a.managerEmail);
    }
  });

  const visited = new Set();  // 已確認無迴圈的節點
  const cycles = [];

  managerOf.forEach((_, startEmail) => {
    if (visited.has(startEmail)) return;
    const cycle = detectCycle(startEmail, managerOf, new Set(), []);
    if (cycle) {
      cycles.push({
        cycle,
        severity: SEVERITY.CRITICAL,
        message:  `發現主管鏈循環引用：${cycle.join(' → ')}`,
      });
    }
    visited.add(startEmail);
  });

  return cycles;
}

// =============================================
// 稽核輔助函式（Private）
// =============================================

/**
 * DFS 循環偵測
 * 
 * @param {string} email
 * @param {Map}    managerOf
 * @param {Set}    currentPath - 當前 DFS 路徑上的節點（偵測循環用）
 * @param {Array}  pathArr     - 路徑陣列（用於回傳可讀的循環路徑）
 * @returns {Array|null} 循環路徑或 null
 */
function detectCycle(email, managerOf, currentPath, pathArr) {
  if (currentPath.has(email)) {
    // 找到循環，回傳從循環起點開始的路徑
    const cycleStart = pathArr.indexOf(email);
    return [...pathArr.slice(cycleStart), email];
  }

  const manager = managerOf.get(email);
  if (!manager) return null; // 到達根節點，無循環

  currentPath.add(email);
  pathArr.push(email);

  const result = detectCycle(manager, managerOf, currentPath, pathArr);

  currentPath.delete(email);
  pathArr.pop();

  return result;
}

/**
 * 判斷 A 欄是否含多個角色（以逗號分隔）
 * 
 * @param {string} value
 * @returns {boolean}
 */
function hasMultipleRoles(value) {
  if (!value) return false;
  return value.split(',').map(s => s.trim()).filter(Boolean).length > 1;
}

/**
 * 從一筆 RACI 記錄中提取所有角色代碼（不去重）
 * 
 * @param {Object} raciItem
 * @returns {Array<string>}
 */
function extractRoleCodes(raciItem) {
  const raw = [raciItem.R, raciItem.A, raciItem.C, raciItem.I]
    .filter(Boolean)
    .join(',');
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * 判斷 entityId 是否為 PERSON 類型（包含 @）
 * 
 * @param {string} entityId
 * @returns {boolean}
 */
function isPersonEntity(entityId) {
  return entityId && entityId.includes('@');
}

/**
 * 判斷驗證項目是否為 Critical 嚴重度
 * 
 * @param {string} checkId
 * @returns {boolean}
 */
function isCritical(checkId) {
  return ['accountability_uniqueness', 'manager_cycle'].includes(checkId);
}

// =============================================
// 稽核報告匯出
// =============================================

/**
 * 將稽核結果格式化為 CSV 字串（前端用 Blob 下載）
 * 
 * @returns {string} JSON 回應，data 為 CSV 字串
 */
function exportAuditReport() {
  try {
    if (!checkPermission('audit.export')) return errorResponse('無匯出稽核報告的權限');

    const auditResult = JSON.parse(runFullAudit());
    if (!auditResult.success) return runFullAudit();

    const { results } = auditResult.data;
    const lines = ['驗證項目,通過,異常數,嚴重度,問題描述,相關欄位'];

    results.forEach(check => {
      if (check.issues.length === 0) {
        lines.push(`${check.label},是,0,,,""`);
        return;
      }
      check.issues.forEach(issue => {
        const desc = (issue.message || '').replace(/,/g, '，');
        const detail = JSON.stringify(issue).replace(/,/g, '，').replace(/"/g, '');
        lines.push(`${check.label},否,${check.issueCount},${issue.severity},${desc},${detail}`);
      });
    });

    return successResponse({ csv: lines.join('\n') });
  } catch (error) {
    return errorResponse(error.message);
  }
}
