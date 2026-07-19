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
      { id: 'org_cycle',                 label: '組織樹無迴圈',   fn: _checkOrgCycle },
      { id: 'manager_cycle',             label: '主管鏈無迴圈',   fn: _checkManagerCycle },
      { id: 'assignment_resigned',       label: '離職人員殘留檢查', fn: _checkAssignmentResignedPerson },
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

function checkOrgCycle() {
  try {
    if (!checkPermission('audit.run')) return errorResponse('無權限');
    return successResponse(_checkOrgCycle());
  } catch (e) { return errorResponse(e.message); }
}

function checkAssignmentResignedPerson() {
  try {
    if (!checkPermission('audit.run')) return errorResponse('無權限');
    return successResponse(_checkAssignmentResignedPerson());
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
      email:        a.email,
      name:         a.name,
      orgCode:      a.orgCode,
      orgName:      a.orgName || '',
      title:        a.title || '',
      managerEmail: a.managerEmail || '',
      managerName:  a.managerName || '',
      rowIndex:     a.rowIndex,
      severity:     SEVERITY.WARNING,
      message:      `職務配置第 ${a.rowIndex} 列：員工 ${a.name || '未命名'}（${a.email || '—'}）填寫的所屬組別代碼 ${a.orgCode} 在組織架構表中不存在。`,
      suggestion:   `請檢查人員職務配置表第 ${a.rowIndex} 列的「所屬組別代碼」是否拼寫錯誤，並比對組織架構表是否已建立代碼 ${a.orgCode}；若尚未建檔，請先新增該組織節點。`,
    }));
}

/**
 * 5. 組織樹無迴圈：Sheet 2 的 parentCode 不可形成循環
 *
 * @returns {Array<{cycle, severity}>}
 */
function _checkOrgCycle() {
  const orgData = DataService.getSheet2Data(null);
  const analysis = analyzeOrgGraph(orgData);
  return analysis.warnings
    .filter(warning => warning.type === 'cycle' || warning.type === 'self_parent')
    .map(warning => ({
      code: warning.code,
      parentCode: warning.parentCode,
      cycle: warning.path || [warning.code, warning.code],
      severity: SEVERITY.CRITICAL,
      message: warning.message,
    }));
}

/**
 * 6. 主管鏈無迴圈：以「每筆職務配置」為節點檢查主管鏈是否循環
 * 
 * 演算法說明：
 * - 建立有向圖：職務配置列 → 該列主管對應的所有職務配置列
 * - 對每個節點執行 DFS，追蹤「當前路徑」中的節點
 * - 若在 DFS 中再次遇到路徑上的節點，即找到循環
 * 
 * @returns {Array<{cycle, severity}>}
 */
function _checkManagerCycle() {
  const assignments = DataService.getAllAssignments();
  const nodes = assignments
    .filter(a => a.email)
    .map(a => ({
      rowIndex: a.rowIndex,
      email: a.email,
      name: a.name || '',
      orgCode: a.orgCode || '',
      orgName: a.orgName || '',
      managerEmail: a.managerEmail || '',
      managerName: a.managerName || '',
    }));
  const nodesByEmail = new Map();
  nodes.forEach(node => {
    const emailKey = String(node.email || '').trim().toLowerCase();
    if (!nodesByEmail.has(emailKey)) nodesByEmail.set(emailKey, []);
    nodesByEmail.get(emailKey).push(node);
  });

  const adjacency = new Map();
  nodes.forEach(node => {
    const managerKey = String(node.managerEmail || '').trim().toLowerCase();
    adjacency.set(node.rowIndex, managerKey ? (nodesByEmail.get(managerKey) || []) : []);
  });

  const visited = new Set();
  const seenCycles = new Set();
  const cycles = [];

  nodes.forEach(startNode => {
    if (visited.has(startNode.rowIndex)) return;
    const cycle = detectManagerCycle_(startNode, adjacency, new Set(), []);
    if (cycle) {
      const cycleKey = canonicalizeCycleKey_(cycle);
      if (!seenCycles.has(cycleKey)) {
        seenCycles.add(cycleKey);
        cycles.push({
          cycle: cycle.map(formatManagerCycleNode_),
          cycleDetails: cycle.map(node => ({
            rowIndex: node.rowIndex,
            email: node.email,
            name: node.name,
            orgCode: node.orgCode,
            orgName: node.orgName,
            managerEmail: node.managerEmail,
            managerName: node.managerName,
          })),
          severity: SEVERITY.CRITICAL,
          message: `發現主管鏈循環引用：${cycle.map(formatManagerCycleNode_).join(' → ')}`,
        });
      }
    }
    visited.add(startNode.rowIndex);
  });

  return cycles;
}

// =============================================
// 稽核輔助函式（Private）
// =============================================

/**
 * DFS 循環偵測
 * 
 * @param {Object} node
 * @param {Map}    adjacency
 * @param {Set}    currentPath - 當前 DFS 路徑上的節點（偵測循環用）
 * @param {Array}  pathArr     - 路徑陣列（用於回傳可讀的循環路徑）
 * @returns {Array|null} 循環路徑或 null
 */
function detectManagerCycle_(node, adjacency, currentPath, pathArr) {
  if (currentPath.has(node.rowIndex)) {
    const cycleStart = pathArr.findIndex(item => item.rowIndex === node.rowIndex);
    return [...pathArr.slice(cycleStart), node];
  }

  const nextNodes = adjacency.get(node.rowIndex) || [];
  if (nextNodes.length === 0) return null;

  currentPath.add(node.rowIndex);
  pathArr.push(node);

  for (let i = 0; i < nextNodes.length; i++) {
    const result = detectManagerCycle_(nextNodes[i], adjacency, currentPath, pathArr);
    if (result) {
      currentPath.delete(node.rowIndex);
      pathArr.pop();
      return result;
    }
  }

  currentPath.delete(node.rowIndex);
  pathArr.pop();
  return null;
}

function formatManagerCycleNode_(node) {
  const email = node.email || 'unknown';
  const orgCode = node.orgCode || '—';
  return `${email} (${orgCode})`;
}

function canonicalizeCycleKey_(cycle) {
  const ids = cycle.slice(0, -1).map(node => String(node.rowIndex));
  if (ids.length === 0) return '';

  const rotations = ids.map((_, idx) => ids.slice(idx).concat(ids.slice(0, idx)).join('>'));
  const reversed = [...ids].reverse();
  const reverseRotations = reversed.map((_, idx) => reversed.slice(idx).concat(reversed.slice(0, idx)).join('>'));
  return rotations.concat(reverseRotations).sort()[0];
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
 * 檢查：職務配置表中是否殘留狀態為「離職」的人員
 * 
 * @returns {Array<{location, description, action, severity}>}
 */
function _checkAssignmentResignedPerson() {
  const issues = [];
  const allPeople = DataService.getSheet1Data();
  const resignedEmails = new Set(
    allPeople
      .filter(p => String(p.status || '').trim() === '離職' && p.email)
      .map(p => String(p.email).trim().toLowerCase())
  );
  const resignedNames = new Set(
    allPeople
      .filter(p => String(p.status || '').trim() === '離職' && !p.email)
      .map(p => String(p.name).trim())
  );

  const assignments = DataService.getAllAssignments();
  assignments.forEach(item => {
    const emailKey = String(item.email || '').trim().toLowerCase();
    const nameKey = String(item.name || '').trim();

    const isResignedEmail = emailKey && resignedEmails.has(emailKey);
    const isResignedName = !emailKey && nameKey && resignedNames.has(nameKey);

    if (isResignedEmail || isResignedName) {
      issues.push({
        severity: SEVERITY.WARNING,
        location: `Sheet 3: 列 ${item.rowIndex}`,
        message:  `職務配置殘留已離職人員: ${item.name || item.email} (組別: ${item.orgCode})`,
        action: '請至人員職務配置表刪除該筆無效紀錄',
      });
    }
  });

  return issues;
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
  return ['accountability_uniqueness', 'org_cycle', 'manager_cycle'].includes(checkId);
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
