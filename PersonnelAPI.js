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
 * @param {{email, name, assetGroupCode, assetGroupName}} personObj
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
 * @param {{name, assetGroupCode, assetGroupName}} personObj
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

  // 偵測矩陣兼任（新舊直屬主管不同）
  const existing = DataService.getSheet3DataByEmail(assignObj.email);
  const hasDiffManager = existing.length > 0 &&
    existing.some(a => a.managerEmail !== assignObj.managerEmail);

  DataService.appendAssignment({
    ...assignObj,
    name: person.name,
    orgName: org.name,
  });
  DataService.appendAuditLog('ADD', `職務配置: ${assignObj.email}`, `組別: ${assignObj.orgCode}`);

  return successResponse({
    message: '職務配置新增成功',
    matrixConcurrencyWarning: hasDiffManager,
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
    if (!checkPermission('personnel.read.all') &&
        !checkPermission('personnel.read.dept') &&
        !checkPermission('personnel.read.self')) {
      return errorResponse('無查詢職務配置的權限');
    }
    return successResponse(DataService.getSheet3DataByEmail(targetEmail));
  } catch (error) {
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
  if (!personObj.assetGroupCode) {
    return '資訊資產邏輯分組代號為必填';
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
