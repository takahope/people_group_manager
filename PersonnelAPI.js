/**
 * PersonnelAPI.gs — 人員管理 API
 * 職責：人員主檔 CRUD、職務配置管理
 * 
 * 設計原則：
 * - 每個函式先執行 checkPermission()，後端安全不依賴前端隱藏
 * - 所有寫入操作完成後寫入操作日誌
 * - Guard Clause 提前驗證參數，避免深層巢狀
 */

// =============================================
// 人員主檔 CRUD
// =============================================

/**
 * 新增人員至 Sheet 1
 * 
 * @param {{email, name, status}} personObj
 * @returns {string} JSON 回應
 */
function addPerson(personObj) {
  if (!checkPermission('personnel.write')) return errorResponse('無新增人員的權限');

  // 驗證必填欄位
  const validationError = validatePersonObj(personObj);
  if (validationError) return errorResponse(validationError);

  // 確認 Email 不重複
  if (DataService.findPersonByEmail(personObj.email)) {
    return errorResponse(`信箱 ${personObj.email} 已存在於人員主檔`);
  }

  DataService.appendPersonnel(personObj);
  DataService.appendAuditLog('ADD', `人員: ${personObj.email}`, `姓名: ${personObj.name}`);

  return successResponse({ message: '人員新增成功', email: personObj.email });
}

/**
 * 更新 Sheet 1 指定人員資料
 * 
 * @param {string} email
 * @param {{name, status}} personObj
 * @returns {string} JSON 回應
 */
function updatePerson(email, personObj) {
  if (!checkPermission('personnel.write')) return errorResponse('無編輯人員的權限');
  if (!email) return errorResponse('缺少 email 參數');

  const updated = DataService.updatePersonnelByEmail(email, { email, ...personObj });
  if (!updated) return errorResponse(`找不到人員：${email}`);

  DataService.appendAuditLog('UPDATE', `人員: ${email}`, JSON.stringify(personObj));
  return successResponse({ message: '人員更新成功' });
}

/**
 * 刪除 Sheet 1 指定人員
 * 刪除前檢查 Sheet 3 是否仍有職務配置
 * 
 * @param {string} email
 * @returns {string} JSON 回應
 */
function deletePerson(email) {
  if (!checkPermission('personnel.delete')) return errorResponse('無刪除人員的權限');
  if (!email) return errorResponse('缺少 email 參數');

  // 安全機制：確認 Sheet 3 無殘留職務配置
  const assignments = DataService.getSheet3DataByEmail(email);
  if (assignments.length > 0) {
    return errorResponse(`此人員仍有 ${assignments.length} 筆職務配置，請先刪除職務配置後再刪除人員`);
  }

  const deleted = DataService.deletePersonnelByEmail(email);
  if (!deleted) return errorResponse(`找不到人員：${email}`);

  DataService.appendAuditLog('DELETE', `人員: ${email}`, '');
  return successResponse({ message: '人員刪除成功' });
}

// =============================================
// 職務配置管理
// =============================================

/**
 * 新增職務配置至 Sheet 3
 * 
 * @param {{email, orgCode, orgName, title, managerEmail, managerName}} assignObj
 * @returns {string} JSON 回應
 */
function addAssignment(assignObj) {
  if (!checkPermission('assignment.write')) return errorResponse('無新增職務配置的權限');

  const validationError = validateAssignObj(assignObj);
  if (validationError) return errorResponse(validationError);

  // 確認人員存在
  const person = DataService.findPersonByEmail(assignObj.email);
  if (!person) return errorResponse(`人員 ${assignObj.email} 不存在`);

  // 確認組別代碼存在
  const org = DataService.findOrgByCode(assignObj.orgCode);
  if (!org) return errorResponse(`組別代碼 ${assignObj.orgCode} 不存在`);

  // 以與列表相同的主職/兼任規則模擬新增後結果
  const existing = DataService.getSheet3DataByEmail(assignObj.email);
  const pendingAssignment = {
    ...assignObj,
    name: person.name,
    orgName: org.name,
    managerName: assignObj.managerEmail
      ? ((DataService.findPersonByEmail(assignObj.managerEmail) || {}).name || assignObj.managerName || '')
      : '',
    rowIndex: -1,
  };
  const simulatedAssignments = existing.concat([pendingAssignment]);
  const simulatedTypeMap = buildAssignmentTypeMap_(simulatedAssignments);
  const hasMatrixWarning = simulatedTypeMap.get(getAssignmentIdentityKey_(pendingAssignment)) === '矩陣兼任';

  DataService.appendAssignment({
    ...assignObj,
    name: person.name,
    orgName: org.name,
  });
  DataService.appendAuditLog('ADD', `職務配置: ${assignObj.email}`, `組別: ${assignObj.orgCode}`);

  return successResponse({
    message: '職務配置新增成功',
    matrixConcurrencyWarning: hasMatrixWarning,
  });
}

/**
 * 更新 Sheet 3 指定列
 * 
 * @param {number} rowIndex
 * @param {Object} assignObj
 * @returns {string} JSON 回應
 */
function updateAssignment(rowIndex, assignObj) {
  if (!checkPermission('assignment.write')) return errorResponse('無編輯職務配置的權限');
  if (!rowIndex) return errorResponse('缺少 rowIndex 參數');

  DataService.updateAssignmentByRow(rowIndex, assignObj);
  DataService.appendAuditLog('UPDATE', `職務配置列 ${rowIndex}`, JSON.stringify(assignObj));
  return successResponse({ message: '職務配置更新成功' });
}

/**
 * 刪除 Sheet 3 指定列
 * 
 * @param {number} rowIndex
 * @returns {string} JSON 回應
 */
function deleteAssignment(rowIndex) {
  if (!checkPermission('assignment.write')) return errorResponse('無刪除職務配置的權限');
  if (!rowIndex) return errorResponse('缺少 rowIndex 參數');

  DataService.deleteAssignmentByRow(rowIndex);
  DataService.appendAuditLog('DELETE', `職務配置列 ${rowIndex}`, '');
  return successResponse({ message: '職務配置刪除成功' });
}

// =============================================
// 查詢 API（供前端呼叫）
// =============================================

/**
 * 取得所有人員（依角色過濾範圍）
 * 
 * @returns {string} JSON 回應
 */
function getAllPersonnel() {
  try {
    const email = Session.getActiveUser().getEmail();

    // ADMIN / HR / AUDITOR：取全部
    if (checkPermission('personnel.read.all')) {
      return successResponse(DataService.getSheet1Data());
    }

    // 主管：取轄下成員
    if (checkPermission('personnel.read.dept')) {
      const directReports = DataService.getAllAssignments()
        .filter(a => a.managerEmail === email)
        .map(a => a.email);
      const all = DataService.getSheet1Data();
      return successResponse(all.filter(p => directReports.includes(p.email)));
    }

    // 一般員工：只取本人
    if (checkPermission('personnel.read.self')) {
      const self = DataService.findPersonByEmail(email);
      return successResponse(self ? [self] : []);
    }

    return errorResponse('無查詢人員的權限');
  } catch (error) {
    Logger.log('getAllPersonnel 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

/**
 * 取得特定人員的職務配置
 * 
 * @param {string} targetEmail
 * @returns {string} JSON 回應
 */
function getAssignmentsByEmail(targetEmail) {
  try {
    if (!canAccessPersonnelTarget_(targetEmail)) {
      return errorResponse('無查詢此人員職務配置的權限');
    }
    return successResponse(DataService.getSheet3DataByEmail(targetEmail));
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 取得特定人員的職務詳情，並依主職 / 兼任 / 垂直兼任 / 矩陣兼任分組。
 *
 * @param {string} targetEmail
 * @returns {string} JSON 回應
 */
function getPersonnelAssignmentDetails(targetEmail) {
  try {
    if (!targetEmail) return errorResponse('缺少 targetEmail 參數');
    if (!canAccessPersonnelTarget_(targetEmail)) {
      return errorResponse('無查詢此人員職務配置的權限');
    }

    const person = DataService.findPersonByEmail(targetEmail);
    if (!person) return errorResponse(`找不到人員：${targetEmail}`);

    const assignments = DataService.getSheet3DataByEmail(targetEmail);
    const items = buildAssignmentListItems(assignments);
    const groups = {
      primary: items.filter(item => item.assignmentType === '主職'),
      concurrent: items.filter(item => item.assignmentType === '兼任'),
      vertical: items.filter(item => item.assignmentType === '垂直兼任'),
      matrix: items.filter(item => item.assignmentType === '矩陣兼任'),
    };

    return successResponse({
      person: {
        email: person.email,
        name: person.name,
        status: person.status,
      },
      summary: {
        total: items.length,
        primaryCount: groups.primary.length,
        concurrentCount: groups.concurrent.length,
        verticalCount: groups.vertical.length,
        matrixCount: groups.matrix.length,
      },
      groups,
    });
  } catch (error) {
    Logger.log('getPersonnelAssignmentDetails 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

/**
 * 取得職務配置管理頁列表資料（全量，供前端篩選/分頁）
 *
 * @returns {string} JSON 回應
 */
function getAssignmentList() {
  try {
    if (!checkPermission('assignment.read.all')) {
      return errorResponse('無查詢職務配置列表的權限');
    }

    const assignments = DataService.getAllAssignments();
    const items = buildAssignmentListItems(assignments);
    return successResponse(items);
  } catch (error) {
    Logger.log('getAssignmentList 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

/**
 * 取得職務配置表單需要的人員與組織選項
 *
 * @returns {string} JSON 回應
 */
function getAssignmentFormOptions() {
  try {
    if (!checkPermission('assignment.read.all')) {
      return errorResponse('無查詢職務配置選項的權限');
    }

    const personnel = DataService.getSheet1Data()
      .map(p => ({
        email: p.email,
        name: p.name,
        label: `${p.name} (${p.email})`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'));

    const orgOptions = DataService.getSheet2Data(null)
      .map(org => ({
        code: org.code,
        name: org.name,
        label: `${org.name} (${org.code})`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'));

    return successResponse({
      personnelOptions: personnel,
      orgOptions,
    });
  } catch (error) {
    Logger.log('getAssignmentFormOptions 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

/**
 * 取得近期操作日誌（Dashboard 用）
 * 
 * @returns {string} JSON 回應
 */
function getRecentLogs() {
  try {
    if (!checkPermission('dashboard.full') && !checkPermission('dashboard.dept')) {
      return errorResponse('無查詢日誌的權限');
    }
    return successResponse(DataService.getRecentAuditLogs(10));
  } catch (error) {
    Logger.log('getRecentLogs 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

// =============================================
// 驗證輔助（Private）
// =============================================

/**
 * 驗證人員物件必填欄位
 * 
 * @param {Object} personObj
 * @returns {string|null} 錯誤訊息或 null（驗證通過）
 */
function validatePersonObj(personObj) {
  if (!personObj.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(personObj.email)) {
    return '信箱格式不正確';
  }
  if (!personObj.name || personObj.name.length > 50) {
    return '姓名為必填且不超過 50 字元';
  }
  if (!PERSONNEL_STATUSES.has(personObj.status)) {
    return '員工狀態必須為在職、育嬰、休假或留職停薪';
  }
  return null;
}

/**
 * 驗證職務配置物件必填欄位
 * 
 * @param {Object} assignObj
 * @returns {string|null}
 */
function validateAssignObj(assignObj) {
  if (!assignObj.email)   return '信箱為必填';
  if (!assignObj.orgCode) return '組別代碼為必填';
  if (!assignObj.title)   return '職稱為必填';
  return null;
}

function canAccessPersonnelTarget_(targetEmail) {
  const normalizedTargetEmail = String(targetEmail || '').trim().toLowerCase();
  if (!normalizedTargetEmail) return false;

  if (checkPermission('personnel.read.all')) return true;

  const currentEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  if (!currentEmail) return false;

  if (checkPermission('personnel.read.self')) {
    return normalizedTargetEmail === currentEmail;
  }

  if (checkPermission('personnel.read.dept')) {
    return DataService.getAllAssignments().some(item =>
      String(item.managerEmail || '').trim().toLowerCase() === currentEmail
      && String(item.email || '').trim().toLowerCase() === normalizedTargetEmail
    );
  }

  return false;
}

function buildAssignmentListItems(assignments) {
  const assignmentTypeMap = buildAssignmentTypeMap_(assignments);

  return assignments.map(item => ({
    rowIndex: item.rowIndex,
    email: item.email,
    name: item.name,
    orgCode: item.orgCode,
    orgName: item.orgName,
    title: item.title,
    managerEmail: item.managerEmail,
    managerName: item.managerName,
    assignmentType: assignmentTypeMap.get(getAssignmentIdentityKey_(item)) || '兼任',
  }));
}

function buildAssignmentTypeMap_(assignments) {
  const groupedAssignments = new Map();
  const typeMap = new Map();

  assignments.forEach(item => {
    const emailKey = String(item.email || '').trim().toLowerCase();
    if (!groupedAssignments.has(emailKey)) groupedAssignments.set(emailKey, []);
    groupedAssignments.get(emailKey).push(item);
  });

  groupedAssignments.forEach(personAssignments => {
    const primaryMode = getPrimaryAssignmentMode_(personAssignments);
    const primaryAssignments = isExplicitPrimaryKind_(primaryMode)
      ? personAssignments.filter(item => classifyAssignmentKind_(item.orgCode) === primaryMode)
      : [];
    const primaryManagerEmails = new Set(
      primaryAssignments
        .map(item => String(item.managerEmail || '').trim().toLowerCase())
        .filter(Boolean)
    );

    personAssignments.forEach(item => {
      const itemKey = getAssignmentIdentityKey_(item);
      const itemKind = classifyAssignmentKind_(item.orgCode);
      const managerEmail = String(item.managerEmail || '').trim().toLowerCase();

      if (isFallbackPrimaryMode_(primaryMode)) {
        typeMap.set(itemKey, '主職');
        return;
      }

      if (isExplicitPrimaryKind_(primaryMode) && itemKind === primaryMode) {
        typeMap.set(itemKey, '主職');
        return;
      }

      if (!primaryMode) {
        typeMap.set(itemKey, '兼任');
        return;
      }

      if (isExplicitPrimaryKind_(primaryMode) && isTfAssignment_(item.orgCode)) {
        typeMap.set(itemKey, primaryManagerEmails.has(managerEmail) ? '兼任' : '矩陣兼任');
        return;
      }

      if (!managerEmail || primaryManagerEmails.size === 0) {
        typeMap.set(itemKey, '兼任');
        return;
      }

      typeMap.set(itemKey, primaryManagerEmails.has(managerEmail) ? '垂直兼任' : '矩陣兼任');
    });
  });

  return typeMap;
}

function getPrimaryAssignmentMode_(personAssignments) {
  if (personAssignments.some(item => classifyAssignmentKind_(item.orgCode) === 'PRE')) return 'PRE';
  if (personAssignments.some(item => classifyAssignmentKind_(item.orgCode) === 'CEO')) return 'CEO';
  if (personAssignments.some(item => classifyAssignmentKind_(item.orgCode) === 'DEPT')) return 'DEPT';
  if (personAssignments.some(item => classifyAssignmentKind_(item.orgCode) === 'GRP')) return 'GRP';

  const managerEmails = personAssignments
    .map(item => String(item.managerEmail || '').trim().toLowerCase());
  const nonEmptyManagerEmails = [...new Set(managerEmails.filter(Boolean))];
  if (nonEmptyManagerEmails.length === 1) return 'FALLBACK_SINGLE_MANAGER';
  if (managerEmails.length > 0 && managerEmails.every(email => !email)) return 'FALLBACK_NO_MANAGER';

  return null;
}

function classifyAssignmentKind_(orgCode) {
  const normalized = String(orgCode || '').trim().toUpperCase();
  if (normalized === 'PRE') return 'PRE';
  if (normalized === 'CEO') return 'CEO';
  if (normalized.startsWith('DEPT-')) return 'DEPT';
  if (normalized.startsWith('GRP-')) return 'GRP';
  return 'OTHER';
}

function isExplicitPrimaryKind_(primaryMode) {
  return primaryMode === 'PRE'
    || primaryMode === 'CEO'
    || primaryMode === 'DEPT'
    || primaryMode === 'GRP';
}

function isFallbackPrimaryMode_(primaryMode) {
  return primaryMode === 'FALLBACK_SINGLE_MANAGER'
    || primaryMode === 'FALLBACK_NO_MANAGER';
}

function isTfAssignment_(orgCode) {
  return String(orgCode || '').trim().toUpperCase().startsWith('TF-');
}

function getAssignmentIdentityKey_(assignment) {
  return [
    String(assignment.email || '').trim().toLowerCase(),
    String(assignment.orgCode || '').trim().toUpperCase(),
    String(assignment.title || '').trim(),
    String(assignment.managerEmail || '').trim().toLowerCase(),
    String(assignment.rowIndex || ''),
  ].join('||');
}
