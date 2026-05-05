/**
 * OrgAPI.gs — 組織架構 API
 * 職責：組織樹查詢、駐站管理員清單、垂直兼任識別、組織節點 CRUD
 */

// =============================================
// 組織架構樹查詢
// =============================================

/**
 * 取得組織樹（含 children 巢狀結構）
 * 
 * @param {string|null} orgType - 'ORG'|'TF'|'PARTNER'|'GOV'|null
 * @returns {string} JSON 回應，巢狀樹狀結構
 */
function getOrgTree(orgType) {
  try {
    if (!checkPermission('org.read')) return errorResponse('無查詢組織架構的權限');

    const flatList = DataService.getSheet2Data(orgType);
    const tree = buildSafeOrgTree(flatList);
    return successResponse(tree);
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 取得指定組織節點及其子樹的成員清單。
 *
 * 資料來源為 Sheet 3 人員職務配置，顯示範圍含被點擊節點本身與其所有安全子節點。
 * @param {string} orgCode
 * @returns {string} JSON 回應
 */
function getOrgMemberList(orgCode) {
  try {
    if (!checkPermission('org.read')) return errorResponse('無查詢組織成員清單的權限');
    if (!orgCode) return errorResponse('缺少 orgCode 參數');

    const orgData = DataService.getSheet2Data(null);
    const analysis = analyzeOrgGraph(orgData);
    const org = analysis.nodesByCode.get(orgCode);
    if (!org) return errorResponse(`找不到組織節點：${orgCode}`);

    const subtreeCodes = analysis.descendantsByCode.get(orgCode) || new Set([orgCode]);
    const assignments = DataService.getAllAssignments()
      .filter(item => subtreeCodes.has(item.orgCode));
    const sections = buildOrgMemberSections_(orgCode, analysis, assignments);
    const warnings = analysis.warnings.filter(item =>
      subtreeCodes.has(item.code) || subtreeCodes.has(item.parentCode)
    );

    return successResponse({
      org: {
        code: org.code,
        name: org.name,
        alias: org.alias || '',
        type: org.type,
        level: org.level,
        parentCode: org.parentCode || '',
      },
      summary: {
        orgCount: subtreeCodes.size,
        assignmentCount: assignments.length,
      },
      sections,
      warnings,
    });
  } catch (error) {
    return errorResponse(error.message);
  }
}

// =============================================
// 駐站管理員儀表板
// =============================================

/**
 * 取得所有駐站管理員清單（含兼任識別）
 * 
 * 查詢邏輯：
 * 1. 找出 Sheet 3 中收案組（GRP-REC）的所有直屬主管 Email（去重）
 * 2. 對每位站長查詢其在 Sheet 3 的職務，判斷是否兼任
 * 
 * @returns {string} JSON 回應
 */
function getStationManagers() {
  try {
    if (!checkPermission('station.read')) return errorResponse('無查詢駐站管理員的權限');

    // 1. 取出所有收案組成員的直屬主管 Email（去重）
    const recMembers = DataService.getSheet3DataByOrgCode('GRP-REC');
    const managerEmails = [...new Set(
      recMembers.map(a => a.managerEmail).filter(Boolean)
    )];

    // 2. 對每位站長建立卡片資料
    const managers = managerEmails.map(email => buildStationManagerCard(email));

    return successResponse(managers);
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 建立單一駐站管理員的卡片資料
 * 
 * 提取此函式讓 getStationManagers 的迴圈邏輯清晰
 * @param {string} email
 * @returns {Object}
 */
function buildStationManagerCard(email) {
  const person = DataService.findPersonByEmail(email);
  const assignments = DataService.getSheet3DataByEmail(email);

  // 取得在收案組的職稱
  const recAssignment = assignments.find(a => a.orgCode === 'GRP-REC');
  const title = recAssignment ? recAssignment.title : '';

  // 兼任標記：職稱非「駐站管理員」則表示兼任
  const isConcurrent = title !== '駐站管理員';

  // 下屬成員：以此 email 為直屬主管的收案組成員
  const members = DataService.getSheet3DataByOrgCode('GRP-REC')
    .filter(a => a.managerEmail === email);

  return {
    email,
    name:         person ? person.name : email,
    title,
    isConcurrent,
    members:      members.map(m => ({ email: m.email, name: m.name, title: m.title })),
  };
}

// =============================================
// 兼任識別
// =============================================

/**
 * 檢查此人員在 Sheet 2 是否有垂直兼任
 * 
 * 垂直兼任條件：
 * - 此人出現在 Sheet 2 的「管理人員信箱」欄
 * - 但在 Sheet 3 只有一筆職務配置記錄
 * 
 * @param {string} email
 * @returns {string} JSON 回應
 */
function detectVerticalConcurrency(email) {
  try {
    const managedOrgs = DataService.getSheet2Data(null)
      .filter(o => o.managerEmail === email);

    if (managedOrgs.length === 0) {
      return successResponse({ isVertical: false, managedOrgs: [] });
    }

    const assignments = DataService.getSheet3DataByEmail(email);
    // 在 Sheet 3 只有一筆記錄 → 垂直兼任
    const isVertical = assignments.length <= 1;

    return successResponse({ isVertical, managedOrgs });
  } catch (error) {
    return errorResponse(error.message);
  }
}

// =============================================
// 組織節點 CRUD
// =============================================

/**
 * 新增組織節點至 Sheet 2
 * 
 * @param {{type, level, code, name, alias, parentCode, managerEmail, managerName}} nodeObj
 * @returns {string} JSON 回應
 */
function addOrgNode(nodeObj) {
  try {
    if (!checkPermission('org.write')) return errorResponse('無新增組織節點的權限');

    const validationError = validateOrgNode(nodeObj, null);
    if (validationError) return errorResponse(validationError);

    // 確認代碼不重複
    if (DataService.findOrgByCode(nodeObj.code)) {
      return errorResponse(`組織代碼 ${nodeObj.code} 已存在`);
    }

    DataService.appendOrgNode(nodeObj);
    DataService.appendAuditLog('ADD', `組織節點: ${nodeObj.code}`, `名稱: ${nodeObj.name}`);
    return successResponse({ message: '組織節點新增成功' });
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 更新 Sheet 2 指定節點
 * 
 * @param {string} code
 * @param {Object} nodeObj
 * @returns {string} JSON 回應
 */
function updateOrgNode(code, nodeObj) {
  try {
    if (!checkPermission('org.write')) return errorResponse('無編輯組織節點的權限');
    if (!code) return errorResponse('缺少 code 參數');

    const existing = DataService.findOrgByCode(code);
    if (!existing) return errorResponse(`找不到組織節點：${code}`);

    if (!nodeObj || nodeObj.code !== code) {
      return errorResponse('目前不支援變更既有組織代碼');
    }

    const validationError = validateOrgNode(nodeObj, code);
    if (validationError) return errorResponse(validationError);

    const updated = DataService.updateOrgNodeByCode(code, nodeObj);
    if (!updated) return errorResponse(`更新組織節點失敗：${code}`);

    DataService.appendAuditLog('UPDATE', `組織節點: ${code}`, JSON.stringify(nodeObj));
    return successResponse({ message: '組織節點更新成功' });
  } catch (error) {
    return errorResponse(error.message);
  }
}

// =============================================
// 驗證輔助
// =============================================

function validateOrgNode(nodeObj, currentCode) {
  if (!nodeObj.type  || !['ORG','TF','PARTNER','GOV'].includes(nodeObj.type)) return '組織類型無效';
  if (!nodeObj.level || isNaN(nodeObj.level)) return '層級為必填數字';
  if (!nodeObj.code)  return '代碼為必填';
  if (!nodeObj.name)  return '名稱為必填';
  if (nodeObj.parentCode && nodeObj.parentCode === nodeObj.code) return 'parentCode 不可指向自己';

  if (nodeObj.parentCode) {
    const parent = DataService.findOrgByCode(nodeObj.parentCode);
    if (!parent) return `上層組織代碼 ${nodeObj.parentCode} 不存在`;
  }

  const validationError = validateOrgCycle_(nodeObj, currentCode);
  if (validationError) return validationError;

  return null;
}

function validateOrgCycle_(nodeObj, currentCode) {
  const nextOrgData = DataService.getSheet2Data(null).map(item => (
    item.code === currentCode ? { ...item, ...nodeObj } : item
  ));

  if (!currentCode) {
    nextOrgData.push({
      type: nodeObj.type,
      level: Number(nodeObj.level),
      code: nodeObj.code,
      name: nodeObj.name,
      alias: nodeObj.alias || '',
      parentCode: nodeObj.parentCode || '',
      managerEmail: nodeObj.managerEmail || '',
      managerName: nodeObj.managerName || '',
    });
  }

  const analysis = analyzeOrgGraph(nextOrgData);
  if (analysis.cycles.length === 0) return null;

  const relatedCycle = analysis.cycles.find(path => path.includes(nodeObj.code));
  if (!relatedCycle) return null;

  return `此設定會形成組織循環：${relatedCycle.join(' -> ')}`;
}

function buildOrgMemberSections_(orgCode, analysis, assignments) {
  const sections = [];
  const assignmentsByOrgCode = new Map();

  assignments.forEach(item => {
    if (!assignmentsByOrgCode.has(item.orgCode)) assignmentsByOrgCode.set(item.orgCode, []);
    assignmentsByOrgCode.get(item.orgCode).push({
      email: item.email,
      name: item.name,
      orgCode: item.orgCode,
      orgName: item.orgName,
      title: item.title,
      managerEmail: item.managerEmail || '',
      managerName: item.managerName || '',
      rowIndex: item.rowIndex,
    });
  });

  walkOrgSubtree_(orgCode, analysis, 0, (node, depthFromSelected) => {
    const orgAssignments = assignmentsByOrgCode.get(node.code) || [];
    if (orgAssignments.length === 0) return;

    sections.push({
      orgCode: node.code,
      orgName: node.name,
      orgAlias: node.alias || '',
      level: node.level,
      depthFromSelected,
      assignments: orgAssignments,
    });
  });

  return sections;
}

function walkOrgSubtree_(orgCode, analysis, depth, visitor) {
  const node = analysis.nodesByCode.get(orgCode);
  if (!node) return;

  visitor(node, depth);
  const childCodes = analysis.safeChildrenMap.get(orgCode) || [];
  childCodes.forEach(childCode => walkOrgSubtree_(childCode, analysis, depth + 1, visitor));
}
