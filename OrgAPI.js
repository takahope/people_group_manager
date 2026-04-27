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
    const tree = buildTree(flatList);
    return successResponse(tree);
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 將平面清單轉為巢狀樹狀結構
 * 
 * 提取此函式以隔離「樹建構邏輯」，讓 getOrgTree 保持精簡
 * 演算法：Map-based O(n)，避免 O(n²) 巢狀迴圈
 * 
 * @param {Array} flatList
 * @returns {Array} 根節點陣列
 */
function buildTree(flatList) {
  const nodeMap = new Map();
  const roots = [];

  // 第一遍：建立所有節點的 Map（含空的 children 陣列）
  flatList.forEach(node => {
    nodeMap.set(node.code, { ...node, children: [] });
  });

  // 第二遍：依 parentCode 掛上子節點
  nodeMap.forEach(node => {
    if (!node.parentCode) {
      roots.push(node);
      return;
    }
    const parent = nodeMap.get(node.parentCode);
    if (parent) {
      parent.children.push(node);
    } else {
      // 父節點不存在（資料異常），放入根層
      roots.push(node);
    }
  });

  return roots;
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

    const validationError = validateOrgNode(nodeObj);
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

    const updated = DataService.updateOrgNodeByCode(code, nodeObj);
    if (!updated) return errorResponse(`找不到組織節點：${code}`);

    DataService.appendAuditLog('UPDATE', `組織節點: ${code}`, JSON.stringify(nodeObj));
    return successResponse({ message: '組織節點更新成功' });
  } catch (error) {
    return errorResponse(error.message);
  }
}

// =============================================
// 驗證輔助
// =============================================

function validateOrgNode(nodeObj) {
  if (!nodeObj.type  || !['ORG','TF','PARTNER','GOV'].includes(nodeObj.type)) return '組織類型無效';
  if (!nodeObj.level || isNaN(nodeObj.level)) return '層級為必填數字';
  if (!nodeObj.code)  return '代碼為必填';
  if (!nodeObj.name)  return '名稱為必填';
  return null;
}
