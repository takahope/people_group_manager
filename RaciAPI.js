/**
 * RaciAPI.gs — RACI 矩陣查詢 API
 * 職責：RACI 主表查詢、角色解析（Parser 邏輯）、個人責任查詢
 */

// =============================================
// RACI 主表查詢
// =============================================

/**
 * 依任務代碼取得 RACI 記錄
 * 
 * @param {string} taskCode
 * @returns {string} JSON 回應
 */
function getRaciByTask(taskCode) {
  try {
    if (!checkPermission('raci.read')) return errorResponse('無查詢 RACI 的權限');
    return successResponse(DataService.getSheet4Data(taskCode));
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 依角色代碼查詢此角色在所有 RACI 中的記錄
 * 回傳每筆記錄中此角色扮演的位置（R/A/C/I）
 * 
 * @param {string} roleCode
 * @returns {string} JSON 回應，含 position 欄位
 */
function getRaciByRole(roleCode) {
  try {
    if (!checkPermission('raci.read')) return errorResponse('無查詢 RACI 的權限');

    const all = DataService.getSheet4Data(null);
    const results = [];

    all.forEach(item => {
      const positions = findRolePositions(roleCode, item);
      if (positions.length > 0) {
        results.push({ ...item, positions });
      }
    });

    return successResponse(results);
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 依個人 Email 查詢其在 RACI 中的職責
 * 先解析此人的角色代碼，再呼叫 getRaciByRole
 * 
 * @param {string} email
 * @returns {string} JSON 回應
 */
function getRaciByEmail(email) {
  try {
    if (!checkPermission('raci.read')) return errorResponse('無查詢 RACI 的權限');

    const roleCodes = resolveEmailToRoleCodes(email);
    if (roleCodes.length === 0) {
      return successResponse({ roles: [], raciItems: [] });
    }

    // 合併所有角色的 RACI 記錄
    const all = DataService.getSheet4Data(null);
    const resultMap = new Map(); // 以 itemCode 去重

    roleCodes.forEach(roleCode => {
      all.forEach(item => {
        const positions = findRolePositions(roleCode, item);
        if (positions.length === 0) return;

        const key = item.itemCode;
        if (!resultMap.has(key)) {
          resultMap.set(key, { ...item, matchedRoles: [] });
        }
        resultMap.get(key).matchedRoles.push({ roleCode, positions });
      });
    });

    return successResponse({
      roles: roleCodes,
      raciItems: [...resultMap.values()],
    });
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 取得完整角色對照表
 * 
 * @returns {string} JSON 回應
 */
function getRoleMap() {
  try {
    if (!checkPermission('rolemap.read')) return errorResponse('無查詢角色對照表的權限');
    return successResponse(DataService.getSheet5Data());
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 解析角色代碼，取得對應的實體人員清單
 * 支援 PERSON / GROUP / RULE / EXTERNAL 四種實體類型
 * 
 * @param {string} roleCode
 * @returns {string} JSON 回應
 */
function resolveRole(roleCode) {
  try {
    if (!checkPermission('raci.read')) return errorResponse('無查詢角色的權限');

    const roleRows = DataService.findRolesByCode(roleCode);
    if (roleRows.length === 0) return errorResponse(`角色代碼 ${roleCode} 不存在`);

    const primaryRole = roleRows[0];
    const entities = roleRows.flatMap(role => resolveEntityId(role.entityId));
    return successResponse({
      role: {
        roleCode: primaryRole.roleCode,
        roleName: primaryRole.roleName,
      },
      bindings: roleRows,
      entities: dedupeResolvedEntities_(entities),
    });
  } catch (error) {
    return errorResponse(error.message);
  }
}

// =============================================
// 個人責任查詢（自助查詢）
// =============================================

/**
 * 取得當前登入者的個人 RACI 責任
 * 依 R/A/C/I 分類回傳
 * 
 * @returns {string} JSON 回應
 */
function getMyRaciTasks() {
  try {
    if (!checkPermission('raci.read')) return errorResponse('無查詢 RACI 的權限');

    const email = Session.getActiveUser().getEmail();
    const result = JSON.parse(getRaciByEmail(email));
    if (!result.success) return getRaciByEmail(email);

    // 依 position 分類
    const classified = { R: [], A: [], C: [], I: [] };
    result.data.raciItems.forEach(item => {
      item.matchedRoles.forEach(({ positions }) => {
        positions.forEach(pos => {
          if (classified[pos] && !classified[pos].find(i => i.itemCode === item.itemCode)) {
            classified[pos].push(item);
          }
        });
      });
    });

    return successResponse({
      email,
      ...classified,
    });
  } catch (error) {
    return errorResponse(error.message);
  }
}

// =============================================
// Parser 邏輯（Private）
// =============================================

/**
 * 找出某角色代碼在一筆 RACI 記錄中扮演的位置
 * 使用 split(',') 處理多角色欄位（如 "ROLE-A, ROLE-B"）
 * 
 * @param {string} roleCode
 * @param {Object} raciItem
 * @returns {Array<string>} 位置陣列，例如 ['R', 'C']
 */
function findRolePositions(roleCode, raciItem) {
  const positions = [];
  const raciFields = { R: raciItem.R, A: raciItem.A, C: raciItem.C, I: raciItem.I };

  Object.entries(raciFields).forEach(([pos, value]) => {
    if (!value) return;
    const codes = value.split(',').map(c => c.trim());
    if (codes.includes(roleCode)) positions.push(pos);
  });

  return positions;
}

/**
 * 依 Email 解析此人對應的角色代碼清單
 * 
 * 解析邏輯：在 Sheet 5 中尋找 entityId 符合以下條件的角色：
 * 1. PERSON 類型：entityId === email
 * 2. GROUP 類型：此人在該組的職務配置中
 * 3. RULE 類型：ALL → 所有人；Level=N → 此人的層級符合
 * 
 * @param {string} email
 * @returns {Array<string>} 角色代碼清單
 */
function resolveEmailToRoleCodes(email) {
  const roleMap = DataService.getSheet5Data();
  const assignments = DataService.getSheet3DataByEmail(email);
  // 同時納入主要組別與兼任組別代碼，去除空值並去重
  const orgCodes = [...new Set(
    assignments
      .flatMap(a => [a.orgCode, a.concurrentOrgCode])
      .filter(Boolean)
  )];

  const matchedCodes = roleMap
    .filter(role => matchesEntity(role, email, orgCodes))
    .map(role => role.roleCode);

  return [...new Set(matchedCodes)]; // 去重
}

/**
 * 判斷角色是否對應此人員
 * 
 * 提取此函式以降低 resolveEmailToRoleCodes 的複雜度
 * @param {Object} role
 * @param {string} email
 * @param {Array<string>} orgCodes - 此人所屬組別代碼清單
 * @returns {boolean}
 */
function matchesEntity(role, email, orgCodes) {
  const entityId = role.entityId;

  if (entityId === 'ALL') {
    const person = DataService.findPersonByEmail(email);
    return isActivePersonnel_(person);
  }
  if (entityId === email) return true;
  if (orgCodes.includes(entityId)) return true;

  // RULE 類型：Level=N → 檢查此人的組別層級
  if (entityId && entityId.startsWith('Level=')) {
    const level = parseInt(entityId.split('=')[1]);
    const orgs = DataService.getSheet2Data(null);
    return orgCodes.some(code => {
      const org = orgs.find(o => o.code === code);
      return org && org.level === level;
    });
  }

  return false;
}

/**
 * 解析 entityId 為具體人員或組別清單
 * 
 * @param {string} entityId
 * @returns {Array<Object>} 人員或組別的詳細資料
 */
function resolveEntityId(entityId) {
  if (!entityId) return [];

  // ALL → 全體在勤人員
  if (entityId === 'ALL') {
    return DataService.getSheet1Data()
      .filter(isActivePersonnel_)
      .map(p => ({ type: 'PERSON', ...p }));
  }

  // Email → 單一人員
  if (entityId.includes('@')) {
    const person = DataService.findPersonByEmail(entityId);
    return person ? [{ type: 'PERSON', ...person }] : [];
  }

  // Level=N → 指定層級主管
  if (entityId.startsWith('Level=')) {
    const level = parseInt(entityId.split('=')[1]);
    const orgs = DataService.getSheet2Data(null).filter(o => o.level === level);
    return orgs.map(o => ({ type: 'GROUP', ...o }));
  }

  // 組別代碼 → 查 Sheet 3
  const members = DataService.getSheet3DataByOrgCode(entityId);
  if (members.length > 0) {
    return members.map(m => ({ type: 'PERSON', email: m.email, name: m.name }));
  }

  // 外部代碼（PARTNER / GOV）
  const extOrg = DataService.findOrgByCode(entityId);
  if (extOrg) return [{ type: 'EXTERNAL', ...extOrg }];

  return [];
}

function isActivePersonnel_(person) {
  return !!person && person.status === ACTIVE_PERSONNEL_STATUS;
}

function dedupeResolvedEntities_(entities) {
  const seen = new Set();
  return entities.filter(entity => {
    const key = [
      entity.type || '',
      entity.email || entity.code || entity.entityId || entity.name || '',
    ].join('::');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
