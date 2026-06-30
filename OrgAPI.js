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

    // 由實際資料動態提供可用的組織類型，供前端產生篩選分頁
    // （正式資料的組織類型為中文，demo 為英文代碼，皆能涵蓋）
    const availableTypes = [...new Set(
      DataService.getSheet2Data(null)
        .map(o => o.type)
        .filter(Boolean)
    )];

    return successResponse({ ...tree, availableTypes });
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
    const payload = buildOrgMemberPayload_(orgCode, analysis, DataService.getAllAssignments());
    return successResponse(payload);
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 背景預載全部組織節點的成員清單資料。
 *
 * 供前端在進入組織頁時靜默抓取，避免逐節點重複打 API。
 * @returns {string} JSON 回應
 */
function getOrgMemberListPrefetchData() {
  try {
    if (!checkPermission('org.read')) return errorResponse('無查詢組織成員清單的權限');

    const orgData = DataService.getSheet2Data(null);
    const analysis = analyzeOrgGraph(orgData);
    const assignments = DataService.getAllAssignments();
    const payloadsByCode = {};

    analysis.nodesByCode.forEach((_, orgCode) => {
      payloadsByCode[orgCode] = buildOrgMemberPayload_(orgCode, analysis, assignments);
    });

    return successResponse({
      generatedAt: new Date().toISOString(),
      payloadsByCode,
    });
  } catch (error) {
    return errorResponse(error.message);
  }
}

// =============================================
// 駐站管理員儀表板
// =============================================

/**
 * 取得駐站管理工作台所需資料。
 *
 * @returns {string} JSON 回應
 */
function getStationManagementDashboard() {
  try {
    if (!checkPermission('station.read')) return errorResponse('無查詢駐站管理員的權限');

    const allPersonnel = DataService.getSheet1Data();
    const allAssignments = DataService.getAllAssignments();
    const stationNodes = DataService.getSheet2Data(null)
      .filter(node => isStationOrgCode_(node.code))
      .sort((a, b) => String(a.name || a.code).localeCompare(String(b.name || b.code), 'zh-Hant'));

    const managerOptions = allPersonnel
      .filter(person => person.status === ACTIVE_PERSONNEL_STATUS)
      .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email), 'zh-Hant'))
      .map(person => ({
        email: person.email,
        name: person.name,
        label: `${person.name} (${person.email})`,
      }));

    const stations = stationNodes.map(node => buildStationWorkspaceCard_(node, allAssignments, allPersonnel));
    const warnings = buildStationWorkspaceWarnings_(stations);

    return successResponse({
      canEdit: checkPermission('station.write'),
      managerOptions,
      stations,
      warnings,
    });
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 更新駐站負責人，並同步更新該站所有成員主管欄位。
 *
 * @param {string} stationCode
 * @param {string} managerEmail
 * @returns {string} JSON 回應
 */
function updateStationManager(stationCode, managerEmail) {
  try {
    if (!checkPermission('station.write')) return errorResponse('無編輯駐站管理員的權限');
    if (!stationCode) return errorResponse('缺少 stationCode 參數');
    if (!managerEmail) return errorResponse('缺少 managerEmail 參數');

    const station = DataService.findOrgByCode(stationCode);
    if (!station || !isStationOrgCode_(station.code)) {
      return errorResponse(`找不到駐站：${stationCode}`);
    }

    const manager = DataService.findPersonByEmail(managerEmail);
    if (!manager || manager.status !== ACTIVE_PERSONNEL_STATUS) {
      return errorResponse(`負責人 ${managerEmail} 不存在或非在勤`);
    }

    const updatedNode = {
      ...station,
      managerEmail: manager.email,
      managerName: manager.name,
    };
    const updated = DataService.updateOrgNodeByCode(station.code, updatedNode);
    if (!updated) return errorResponse(`更新駐站負責人失敗：${station.code}`);

    const members = DataService.getAllAssignments()
      .filter(item => item.orgCode === station.code);
    members.forEach(item => {
      DataService.updateAssignmentByRow(item.rowIndex, {
        ...item,
        managerEmail: manager.email,
        managerName: manager.name,
      });
    });

    DataService.appendAuditLog('UPDATE', `駐站負責人: ${station.code}`, `managerEmail: ${manager.email}`);
    return successResponse({ message: '駐站負責人更新成功' });
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 批次搬移駐站成員至其他駐站。
 *
 * @param {Array<number>} rowIndices
 * @param {string} targetStationCode
 * @returns {string} JSON 回應
 */
function reassignStationMembers(rowIndices, targetStationCode) {
  try {
    if (!checkPermission('station.write')) return errorResponse('無調整駐站成員的權限');
    if (!Array.isArray(rowIndices) || rowIndices.length === 0) return errorResponse('請至少選擇一位成員');
    if (!targetStationCode) return errorResponse('缺少 targetStationCode 參數');

    const targetStation = DataService.findOrgByCode(targetStationCode);
    if (!targetStation || !isStationOrgCode_(targetStation.code)) {
      return errorResponse(`找不到目標駐站：${targetStationCode}`);
    }
    if (!targetStation.managerEmail) {
      return errorResponse(`目標駐站 ${targetStation.name || targetStation.code} 尚未設定負責人`);
    }

    const allAssignments = DataService.getAllAssignments();
    const byRowIndex = new Map(allAssignments.map(item => [Number(item.rowIndex), item]));
    const uniqueRowIndices = [...new Set(rowIndices.map(item => Number(item)).filter(Boolean))];

    for (const rowIndex of uniqueRowIndices) {
      const assignment = byRowIndex.get(rowIndex);
      if (!assignment) return errorResponse(`找不到職務配置列：${rowIndex}`);
      if (!isStationOrgCode_(assignment.orgCode)) {
        return errorResponse(`職務配置列 ${rowIndex} 不屬於駐站成員，無法搬移`);
      }
      if (assignment.orgCode === targetStation.code) {
        return errorResponse(`職務配置列 ${rowIndex} 已位於目標駐站`);
      }
    }

    uniqueRowIndices.forEach(rowIndex => {
      const assignment = byRowIndex.get(rowIndex);
      DataService.updateAssignmentByRow(rowIndex, {
        ...assignment,
        orgCode: targetStation.code,
        orgName: targetStation.name,
        managerEmail: targetStation.managerEmail || '',
        managerName: targetStation.managerName || '',
      });
    });

    DataService.appendAuditLog(
      'UPDATE',
      `駐站成員搬移: ${targetStation.code}`,
      JSON.stringify({ rowIndices: uniqueRowIndices, targetStationCode: targetStation.code })
    );

    return successResponse({
      message: '駐站成員調整成功',
      updatedCount: uniqueRowIndices.length,
    });
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 取得所有駐站管理員清單（含兼任識別）
 * 
 * 查詢邏輯：
 * 1. 找出 Sheet 3 中所有駐站成員的直屬主管 Email（去重）
 * 2. 對每位站長查詢其在 Sheet 3 的職務，判斷是否兼任
 * 
 * @returns {string} JSON 回應
 */
function getStationManagers() {
  try {
    if (!checkPermission('station.read')) return errorResponse('無查詢駐站管理員的權限');

    // 1. 取出所有駐站成員的直屬主管 Email（去重）
    const recMembers = DataService.getAllAssignments()
      .filter(a => isStationOrgCode_(a.orgCode));
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
  const title = '駐站管理員';

  // 兼任標記：只要任一職稱含「長」即視為兼任；否則只要有駐站職務即視為專任
  const isConcurrent = getStationManagerConcurrency_(email, assignments);

  // 下屬成員：以此 email 為直屬主管的所有駐站成員
  const members = DataService.getAllAssignments()
    .filter(a => isStationOrgCode_(a.orgCode) && a.managerEmail === email);

  return {
    email,
    name:         person ? person.name : email,
    title,
    isConcurrent,
    members:      members.map(m => ({ email: m.email, name: m.name, title: m.title })),
  };
}

function isStationOrgCode_(orgCode) {
  return String(orgCode || '').trim().toUpperCase().startsWith('GRP-CO-');
}

function buildStationWorkspaceCard_(stationNode, allAssignments, allPersonnel = []) {
  const manager = stationNode.managerEmail
    ? DataService.findPersonByEmail(stationNode.managerEmail)
    : null;
  const members = allAssignments
    .filter(item => item.orgCode === stationNode.code)
    .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email), 'zh-Hant'));
  const warnings = [];

  if (!stationNode.managerEmail) {
    warnings.push('尚未設定駐站負責人');
  }
  if (stationNode.managerEmail && members.some(item => item.managerEmail !== stationNode.managerEmail)) {
    warnings.push('部分成員主管資訊與駐站負責人不一致');
  }
  if (members.length === 0) {
    warnings.push('目前沒有配置任何收案人員');
  }

  const activeMemberCount = members.filter(item => {
    const person = allPersonnel.find(p => p.email === item.email);
    return person && person.status === '在勤';
  }).length;

  return {
    code: stationNode.code,
    name: stationNode.name,
    alias: stationNode.alias || '',
    parentCode: stationNode.parentCode || '',
    managerEmail: stationNode.managerEmail || '',
    managerName: stationNode.managerName || (manager ? manager.name : ''),
    managerLabel: stationNode.managerEmail
      ? `${stationNode.managerName || (manager ? manager.name : stationNode.managerEmail)} (${stationNode.managerEmail})`
      : '',
    memberCount: members.length,
    activeMemberCount: activeMemberCount,
    isManagerConcurrent: stationNode.managerEmail
      ? getStationManagerConcurrency_(stationNode.managerEmail, allAssignments)
      : false,
    warnings,
    members: members.map(item => ({
      rowIndex: item.rowIndex,
      email: item.email,
      name: item.name,
      title: item.title,
      orgCode: item.orgCode,
      orgName: item.orgName,
      managerEmail: item.managerEmail || '',
      managerName: item.managerName || '',
    })),
  };
}

function buildStationWorkspaceWarnings_(stations) {
  const warnings = [];
  stations.forEach(station => {
    station.warnings.forEach(message => {
      warnings.push({
        code: station.code,
        stationName: station.name,
        message: `${station.name || station.code}：${message}`,
      });
    });
  });
  return warnings;
}

function getStationManagerConcurrency_(email, allAssignments) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return false;

  const assignments = (allAssignments || []).filter(item =>
    String(item.email || '').trim().toLowerCase() === normalizedEmail
  );
  if (assignments.length === 0) return false;

  const hasLeaderTitle = assignments.some(item => titleContainsStationLeaderKeyword_(item.title));
  if (hasLeaderTitle) return true;

  return false;
}

function titleContainsStationLeaderKeyword_(title) {
  return String(title || '').trim().includes('長');
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

function buildOrgMemberPayload_(orgCode, analysis, allAssignments) {
  const org = analysis.nodesByCode.get(orgCode);
  if (!org) throw new Error(`找不到組織節點：${orgCode}`);

  const subtreeCodes = analysis.descendantsByCode.get(orgCode) || new Set([orgCode]);
  const assignments = allAssignments.filter(item => subtreeCodes.has(item.orgCode));
  const sections = buildOrgMemberSections_(orgCode, analysis, assignments);
  const warnings = analysis.warnings.filter(item =>
    subtreeCodes.has(item.code) || subtreeCodes.has(item.parentCode)
  );

  return {
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
  };
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
