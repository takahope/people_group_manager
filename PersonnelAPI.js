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

  // 確認 Email 不重複（email 為空的離職人員跳過，避免空字串誤 match 空信箱列）
  if (personObj.email && DataService.findPersonByEmail(personObj.email)) {
    return errorResponse(`信箱 ${personObj.email} 已存在於人員主檔`);
  }

  DataService.appendPersonnel(personObj);
  DataService.appendAuditLog('ADD', `人員: ${personObj.email || `（無信箱）${personObj.name}`}`, `姓名: ${personObj.name}`);

  return successResponse({ message: '人員新增成功', email: personObj.email });
}

/**
 * 更新 Sheet 1 指定人員資料
 *
 * @param {string} email 原信箱；無信箱人員傳空字串，改由 personObj.originalName 定位
 * @param {{name, status, originalName}} personObj originalName 僅作定位鍵，不寫入 Sheet
 * @returns {string} JSON 回應
 */
function updatePerson(email, personObj) {
  if (!checkPermission('personnel.write')) return errorResponse('無編輯人員的權限');

  const obj = Object.assign({}, personObj);
  const originalName = String(obj.originalName || '').trim();
  delete obj.originalName;
  if (!email && !originalName) return errorResponse('缺少 email 參數');

  // 無信箱人員在編輯時補上信箱，需防與既有信箱撞號
  if (!email && obj.email && DataService.findPersonByEmail(obj.email)) {
    return errorResponse(`信箱 ${obj.email} 已存在於人員主檔`);
  }

  // 表單送入的新信箱優先（支援修改信箱），未送則沿用原信箱
  const finalEmail = String(obj.email || '').trim() || email;
  const updated = DataService.updatePersonnelByEmail(email, { ...obj, email: finalEmail }, originalName);
  if (!updated) return errorResponse(`找不到人員：${email || `（無信箱）${originalName}`}`);

  DataService.appendAuditLog('UPDATE', `人員: ${email || `（無信箱）${originalName}`}`, JSON.stringify(obj));
  return successResponse({ message: '人員更新成功' });
}

/**
 * 刪除 Sheet 1 指定人員
 * 刪除前檢查 Sheet 3 是否仍有職務配置
 *
 * @param {string} email
 * @param {string} [name] email 為空時（無信箱的離職人員）以姓名定位
 * @returns {string} JSON 回應
 */
function deletePerson(email, name) {
  if (!checkPermission('personnel.delete')) return errorResponse('無刪除人員的權限');
  const fallbackName = String(name || '').trim();
  if (!email && !fallbackName) return errorResponse('缺少 email 參數');

  // 安全機制：確認 Sheet 3 無殘留職務配置（無信箱者不會有職務配置，跳過）
  if (email) {
    const assignments = DataService.getSheet3DataByEmail(email);
    if (assignments.length > 0) {
      return errorResponse(`此人員仍有 ${assignments.length} 筆職務配置，請先刪除職務配置後再刪除人員`);
    }
  }

  const deleted = DataService.deletePersonnelByEmail(email, fallbackName);
  if (!deleted) return errorResponse(`找不到人員：${email || `（無信箱）${fallbackName}`}`);

  DataService.appendAuditLog('DELETE', `人員: ${email || `（無信箱）${fallbackName}`}`, '');
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
  if (String(person.status || '').trim() === '離職') return errorResponse(`人員 ${assignObj.email} 於主檔狀態為離職，無法配置職務`);

  if (assignObj.managerEmail) {
    const managerPerson = DataService.findPersonByEmail(assignObj.managerEmail);
    if (managerPerson && String(managerPerson.status || '').trim() === '離職') {
      return errorResponse(`直屬主管 ${assignObj.managerEmail} 已離職，請重新選擇現職主管`);
    }
  }

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
    managerName: pendingAssignment.managerName,
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

  const person = assignObj.email ? DataService.findPersonByEmail(assignObj.email) : null;
  if (person && String(person.status || '').trim() === '離職') {
    return errorResponse(`人員 ${assignObj.email} 於主檔狀態為離職，無法配置職務`);
  }
  if (assignObj.managerEmail) {
    const managerPerson = DataService.findPersonByEmail(assignObj.managerEmail);
    if (managerPerson && String(managerPerson.status || '').trim() === '離職') {
      return errorResponse(`直屬主管 ${assignObj.managerEmail} 已離職，請重新選擇現職主管`);
    }
  }
  const org = assignObj.orgCode ? DataService.findOrgByCode(assignObj.orgCode) : null;
  const managerName = assignObj.managerEmail
    ? ((DataService.findPersonByEmail(assignObj.managerEmail) || {}).name || assignObj.managerName || '')
    : '';
  const updatedObj = {
    ...assignObj,
    name: person ? person.name : (assignObj.name || ''),
    orgName: org ? org.name : (assignObj.orgName || ''),
    managerName,
  };

  DataService.updateAssignmentByRow(rowIndex, updatedObj);
  DataService.appendAuditLog('UPDATE', `職務配置列 ${rowIndex}`, JSON.stringify(updatedObj));
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
 * 判斷離職日期是否為今年（Asia/Taipei 時區），用於主管視角的離職人員範圍限制。
 *
 * @param {string} leaveDate 儲存格式為 DataService.js formatCellDate_() 產生的 'yyyy/MM/dd'
 * @returns {boolean}
 */
function isLeaveDateThisYear_(leaveDate) {
  const currentYear = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy');
  return String(leaveDate || '').indexOf(currentYear) === 0;
}

/**
 * 判斷人員是否落在「主管（MGR）可見範圍」：在職子狀態（在勤/育嬰假/休假）＋今年離職者。
 * 為 getAllPersonnel、canAccessPersonnelTarget_、getAccessiblePersonnelList_ 三處共用，
 * 避免各自維護一份過濾條件而漂移。不含直屬部屬限縮（由呼叫端另行套用）。
 *
 * @param {Object|null} person
 * @returns {boolean}
 */
function isMgrVisiblePerson_(person) {
  if (!person) return false;
  if (person.status === '離職') return isLeaveDateThisYear_(person.leaveDate);
  return ACTIVE_PERSONNEL_STATUSES.indexOf(person.status) >= 0;
}

/**
 * 取得目前使用者直屬部屬的 email 集合（小寫），依 Sheet3 職務配置的直屬主管欄位比對。
 *
 * @param {string} currentEmail
 * @returns {Set<string>}
 */
function buildDirectReportEmailSet_(currentEmail) {
  const normalized = String(currentEmail || '').trim().toLowerCase();
  return new Set(
    DataService.getAllAssignments()
      .filter(item => String(item.managerEmail || '').trim().toLowerCase() === normalized)
      .map(item => String(item.email || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * 取得所有人員（依角色過濾範圍）
 *
 * @param {{view?:string}} options
 *   view：主管（personnel.read.dept）可傳 'dept' 切換為部門視角（僅直屬部屬）；其餘角色忽略此參數。
 * @returns {string} JSON 回應
 */
function getAllPersonnel(options) {
  try {
    const email = Session.getActiveUser().getEmail();
    const representativeEmails = buildRepresentativeEmailSet_();
    const decoratePersonnelList = items => (items || []).map(person => ({
      ...person,
      isRepresentative: representativeEmails.has(String(person?.email || '').trim().toLowerCase()),
    }));

    // ADMIN / HR / AUDITOR：取全部
    if (checkPermission('personnel.read.all')) {
      return successResponse(decoratePersonnelList(DataService.getSheet1Data()));
    }

    // 主管：僅「在職」3 種子狀態 + 今年離職者（合作單位/委外廠商/倫理委員會一律排除），隱藏到職/離職日期與電話/手機。
    // 預設全公司範圍；view='dept' 時再限縮為直屬部屬（部門視角）。
    if (checkPermission('personnel.read.dept')) {
      const view = String((options && options.view) || '').trim();
      const directReports = view === 'dept' ? buildDirectReportEmailSet_(email) : null;
      const scoped = DataService.getSheet1Data()
        .filter(p => {
          if (directReports && !directReports.has(String(p.email || '').trim().toLowerCase())) return false;
          return isMgrVisiblePerson_(p);
        })
        .map(p => ({ ...p, hireDate: '', leaveDate: '', phone: '', mobile: '' }));
      return successResponse(decoratePersonnelList(scoped));
    }

    // 一般員工：只取本人
    if (checkPermission('personnel.read.self')) {
      const self = DataService.findPersonByEmail(email);
      return successResponse(decoratePersonnelList(self ? [self] : []));
    }

    return errorResponse('無查詢人員的權限');
  } catch (error) {
    Logger.log('getAllPersonnel 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

function buildRepresentativeEmailSet_() {
  const representativeEmails = new Set();
  DataService.getAllAssignments().forEach(item => {
    if (String(item?.title || '').trim() !== '代表人') return;
    const email = String(item?.email || '').trim().toLowerCase();
    if (email) representativeEmails.add(email);
  });
  return representativeEmails;
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
    return successResponse(
      buildPersonnelAssignmentDetailsPayload_(person, DataService.getSheet3DataByEmail(targetEmail))
    );
  } catch (error) {
    Logger.log('getPersonnelAssignmentDetails 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

/**
 * 批次預載目前使用者可見人員的職務詳情。
 *
 * 供人員管理頁背景靜默載入，避免逐筆點擊時再打 API。
 * @returns {string} JSON 回應
 */
function getPersonnelAssignmentDetailsPrefetchData() {
  try {
    const visiblePersonnel = getAccessiblePersonnelList_();
    const visibleEmailSet = new Set(
      visiblePersonnel.map(item => String(item.email || '').trim().toLowerCase()).filter(Boolean)
    );
    const assignments = DataService.getAllAssignments()
      .filter(item => visibleEmailSet.has(String(item.email || '').trim().toLowerCase()));
    const groupedAssignments = new Map();

    assignments.forEach(item => {
      const emailKey = String(item.email || '').trim().toLowerCase();
      if (!groupedAssignments.has(emailKey)) groupedAssignments.set(emailKey, []);
      groupedAssignments.get(emailKey).push(item);
    });

    const payloadsByEmail = {};
    visiblePersonnel.forEach(person => {
      const normalizedEmail = String(person.email || '').trim().toLowerCase();
      payloadsByEmail[person.email] = buildPersonnelAssignmentDetailsPayload_(
        person,
        groupedAssignments.get(normalizedEmail) || []
      );
    });

    return successResponse({
      generatedAt: new Date().toISOString(),
      payloadsByEmail,
    });
  } catch (error) {
    Logger.log('getPersonnelAssignmentDetailsPrefetchData 錯誤：' + (error.stack || error.message));
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

    const activeAssignments = assignments.filter(item => {
      const emailKey = String(item.email || '').trim().toLowerCase();
      if (emailKey && resignedEmails.has(emailKey)) return false;
      if (!emailKey && resignedNames.has(String(item.name || '').trim())) return false;
      return true;
    });
    const items = buildAssignmentListItems(activeAssignments);
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
      .filter(p => String(p.status || '').trim() !== '離職')
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
// 匯入 / 匯出
// =============================================

/** 匯出可選欄位定義（key → 中文標題），前端複選以此為準。 */
const PERSONNEL_EXPORT_COLUMNS_ = [
  { key: 'email',        label: '信箱' },
  { key: 'name',         label: '姓名' },
  { key: 'status',       label: '員工狀態' },
  { key: 'workLocation', label: '工作地點' },
  { key: 'phone',        label: '電話' },
  { key: 'mobile',       label: '手機' },
  { key: 'hireDate',     label: '到職日期' },
  { key: 'leaveDate',    label: '離職日期' },
];

/** @const {string[]} 主管（受限匯出）固定欄位，須與 js/router.html 的 _PERSONNEL_EXPORT_LIMITED_KEYS 同步。 */
const PERSONNEL_EXPORT_LIMITED_KEYS_ = ['email', 'name', 'status', 'workLocation'];

/**
 * 匯出人員資料（回結構化資料，前端據此產 CSV 或 xlsx）。
 *
 * @param {{columns?:string[], statuses?:string[], includeRepresentative?:boolean}} options
 *   columns：要匯出的欄位 key（信箱恆含）；空＝全部欄位。
 *   statuses：要匯出的員工狀態；空＝全部狀態。
 *   includeRepresentative：是否包含代表人；未指定＝包含。
 * @returns {string} JSON 回應 { headers:[中文標題], keys:[欄位key], rows:[[...]] }
 */
function exportPersonnel(options) {
  const canFull = checkPermission('personnel.export');                          // ADMIN / HR
  const restricted = !canFull && checkPermission('personnel.export.limited');    // MGR
  if (!canFull && !restricted) return errorResponse('無匯出人員資料的權限');

  const opts = options || {};
  const validKeys = PERSONNEL_EXPORT_COLUMNS_.map(c => c.key);

  let selectedKeys;
  let statusFilter;
  if (restricted) {
    // 主管：欄位鎖信箱/姓名/狀態/工作地點；狀態僅允許在職集合的子集，忽略其餘傳入值
    selectedKeys = PERSONNEL_EXPORT_LIMITED_KEYS_.slice();
    const requested = Array.isArray(opts.statuses)
      ? opts.statuses.filter(s => ACTIVE_PERSONNEL_STATUSES.indexOf(s) >= 0)
      : [];
    statusFilter = new Set(requested.length ? requested : ACTIVE_PERSONNEL_STATUSES);
  } else {
    // 決定欄位（信箱恆含且置首）
    selectedKeys = Array.isArray(opts.columns) && opts.columns.length
      ? opts.columns.filter(k => validKeys.indexOf(k) >= 0)
      : validKeys.slice();
    if (selectedKeys.indexOf('email') < 0) selectedKeys.unshift('email');
    // 依 PERSONNEL_EXPORT_COLUMNS_ 的固定順序排列
    selectedKeys = validKeys.filter(k => selectedKeys.indexOf(k) >= 0);
    statusFilter = Array.isArray(opts.statuses) && opts.statuses.length ? new Set(opts.statuses) : null;
  }

  let list = DataService.getSheet1Data();
  if (statusFilter && statusFilter.size) {
    list = list.filter(p => statusFilter.has(p.status));
  }
  if (opts.includeRepresentative === false) {
    const representativeEmails = buildRepresentativeEmailSet_();
    list = list.filter(p => !representativeEmails.has(String(p.email || '').trim().toLowerCase()));
  }

  const labelByKey = {};
  PERSONNEL_EXPORT_COLUMNS_.forEach(c => { labelByKey[c.key] = c.label; });

  const headers = selectedKeys.map(k => labelByKey[k]);
  const rows = list.map(p => selectedKeys.map(k => (p[k] == null ? '' : String(p[k]))));

  return successResponse({ headers, keys: selectedKeys, rows });
}

/**
 * 批次匯入人員（前端已完成衝突解析，records 為最終目標值）。
 *
 * @param {Array<{email,name,status,phone,mobile,hireDate,leaveDate,workLocation,action}>} records
 * @returns {string} JSON 回應 { added, updated, skipped, errors:[{email,reason}] }
 */
/**
 * 匯入專用信箱正規化：已知別名網域一律轉為 @as.edu.tw（保留 @ 前帳號、其他網域原樣保留）。
 * 對應前端 Pages._canonicalizeImportEmail 的模糊比對；此規則僅用於匯入寫入。
 * 別名清單須與前端 _importEmailAliasDomains 同步。
 */
const IMPORT_EMAIL_ALIAS_DOMAINS_ = ['gate.sinica.edu.tw', 'as.edu.tw'];
function canonicalizeImportEmail_(email) {
  const raw = String(email == null ? '' : email).trim();
  const at = raw.lastIndexOf('@');
  if (at < 0) return raw;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1).toLowerCase();
  return IMPORT_EMAIL_ALIAS_DOMAINS_.indexOf(domain) >= 0 ? local + '@as.edu.tw' : raw;
}

function importPersonnelBatch(records) {
  if (!checkPermission('personnel.import')) return errorResponse('無匯入人員資料的權限');

  const list = Array.isArray(records) ? records : [];
  if (!list.length) return errorResponse('沒有可匯入的資料');

  const valid = [];
  const errors = [];
  const seen = new Set();

  list.forEach(rec => {
    // 已知別名網域一律轉為 @as.edu.tw，讓去重、寫入與更新比對都以正規化信箱為準
    const email = canonicalizeImportEmail_(String(rec && rec.email || '').trim());
    const name = String(rec && rec.name || '').trim();
    const displayKey = email || `（無信箱）${name}`;
    // 統一去重鍵：有信箱用信箱，無信箱（離職人員）用姓名
    const key = email ? email.toLowerCase() : (name ? 'name:' + name.toLowerCase() : '');
    if (!key) {
      errors.push({ email: '（無法辨識）', reason: '缺少信箱與姓名' });
      return;
    }
    if (seen.has(key)) {
      errors.push({ email: displayKey, reason: email ? '檔案內信箱重複' : '檔案內姓名重複（無信箱）' });
      return;
    }
    seen.add(key);

    const normalized = {
      email: email,
      name: name,
      status: String(rec.status || '').trim(),
      phone: String(rec.phone || '').trim(),
      mobile: String(rec.mobile || '').trim(),
      hireDate: normalizeDateValue_(rec.hireDate),
      leaveDate: normalizeDateValue_(rec.leaveDate),
      workLocation: String(rec.workLocation || '').trim(),
      forceInsert: rec && rec.forceInsert === true,
    };

    const validationError = validatePersonObj(normalized);
    if (validationError) {
      errors.push({ email: displayKey, reason: validationError });
      return;
    }
    valid.push(normalized);
  });

  const result = valid.length
    ? DataService.bulkImportPersonnel(valid)
    : { added: 0, updated: 0 };

  DataService.appendAuditLog(
    'IMPORT',
    '人員主檔批次匯入',
    `新增: ${result.added}，更新: ${result.updated}，略過: ${errors.length}`
  );

  return successResponse({
    added: result.added,
    updated: result.updated,
    skipped: errors.length,
    errors,
  });
}

/**
 * 寬鬆日期正規化：接受 yyyy/MM/dd、yyyy-MM-dd、yyyy.MM.dd 或可被 Date 解析的字串，
 * 統一輸出為 'yyyy/MM/dd'；空值回 ''；無法解析則保留原字串（不擋整批）。
 *
 * @param {*} v
 * @returns {string}
 */
function normalizeDateValue_(v) {
  if (v === null || v === undefined) return '';
  const raw = String(v).trim();
  if (!raw) return '';

  // 緊湊 yyyyMMdd（如 20260101）
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact && +compact[2] >= 1 && +compact[2] <= 12 && +compact[3] >= 1 && +compact[3] <= 31) {
    return `${compact[1]}/${compact[2]}/${compact[3]}`;
  }

  const m = raw.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) {
    const y = m[1];
    const mo = ('0' + m[2]).slice(-2);
    const d = ('0' + m[3]).slice(-2);
    return `${y}/${mo}/${d}`;
  }

  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    return Utilities.formatDate(parsed, 'Asia/Taipei', 'yyyy/MM/dd');
  }
  return raw;
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
  // 信箱可空（僅憑姓名即可匯入）；有信箱仍須通過格式驗證
  const email = String(personObj.email || '').trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '信箱格式不正確';
  if (!personObj.name || personObj.name.length > 50) {
    return '姓名為必填且不超過 50 字元';
  }
  if (!PERSONNEL_STATUSES.has(personObj.status)) {
    return '員工狀態必須為在勤、育嬰假、休假、合作單位、委外廠商、倫理委員會或離職';
  }
  // 工作地點為選填；若有填寫，僅限三個代碼值
  if (personObj.workLocation && !WORK_LOCATIONS.has(personObj.workLocation)) {
    return '工作地點必須為 bioit、station、outside 或 biobank，或留空';
  }
  // 電話／手機為選填；若有填寫，長度上限 30 字
  if (personObj.phone && String(personObj.phone).length > 30) {
    return '電話長度不可超過 30 字元';
  }
  if (personObj.mobile && String(personObj.mobile).length > 30) {
    return '手機長度不可超過 30 字元';
  }
  // 到職／離職日期為選填，寬鬆驗證：僅限制長度，格式交由 normalizeDateValue_ 正規化
  if (personObj.hireDate && String(personObj.hireDate).length > 20) {
    return '到職日期格式異常';
  }
  if (personObj.leaveDate && String(personObj.leaveDate).length > 20) {
    return '離職日期格式異常';
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
    // MGR 人員清單為全公司範圍（在職子狀態 + 今年離職），故職務查看亦放行同一範圍，
    // 不再限縮為直屬部屬——與 getAllPersonnel / getAccessiblePersonnelList_ 的 MGR 範圍一致。
    const person = DataService.getSheet1Data()
      .find(p => String(p.email || '').trim().toLowerCase() === normalizedTargetEmail);
    return isMgrVisiblePerson_(person);
  }

  return false;
}

function getAccessiblePersonnelList_() {
  const currentEmail = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();

  if (checkPermission('personnel.read.all')) {
    return DataService.getSheet1Data();
  }

  if (checkPermission('personnel.read.dept')) {
    // 與 canAccessPersonnelTarget_ 的 MGR 範圍一致：全公司在職子狀態 + 今年離職，
    // 使職務詳情預載快取涵蓋 MGR 清單中所有可點擊的人員。
    return DataService.getSheet1Data().filter(isMgrVisiblePerson_);
  }

  if (checkPermission('personnel.read.self')) {
    const self = DataService.findPersonByEmail(currentEmail);
    return self ? [self] : [];
  }

  throw new Error('無查詢人員的權限');
}

function buildPersonnelAssignmentDetailsPayload_(person, assignments) {
  const items = buildAssignmentListItems(assignments);
  const groups = {
    primary: items.filter(item => item.assignmentType === '主職'),
    concurrent: items.filter(item => item.assignmentType === '兼任'),
    vertical: items.filter(item => item.assignmentType === '垂直兼任'),
    matrix: items.filter(item => item.assignmentType === '矩陣兼任'),
  };

  return {
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
  };
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
    const primaryLeaderTypeMap = buildPrimaryLeaderTypeMap_(primaryAssignments);
    const primaryAssignmentKeys = new Set(
      primaryAssignments
        .filter(item => primaryLeaderTypeMap.get(getAssignmentIdentityKey_(item)) !== '垂直兼任')
        .map(getAssignmentIdentityKey_)
    );
    const primaryManagerEmails = new Set(
      primaryAssignments
        .filter(item => primaryAssignmentKeys.has(getAssignmentIdentityKey_(item)))
        .map(item => String(item.managerEmail || '').trim().toLowerCase())
        .filter(Boolean)
    );

    personAssignments.forEach(item => {
      const itemKey = getAssignmentIdentityKey_(item);
      const itemKind = classifyAssignmentKind_(item.orgCode);
      const managerEmail = String(item.managerEmail || '').trim().toLowerCase();
      const primaryLeaderType = primaryLeaderTypeMap.get(itemKey);

      if (primaryLeaderType) {
        typeMap.set(itemKey, primaryLeaderType);
        return;
      }

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
        if (!managerEmail || primaryManagerEmails.size === 0) {
          typeMap.set(itemKey, '兼任');
          return;
        }
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

function buildPrimaryLeaderTypeMap_(primaryAssignments) {
  const assignmentsByOrgCode = new Map();
  const leaderTypeMap = new Map();

  primaryAssignments.forEach(item => {
    const orgCodeKey = String(item.orgCode || '').trim().toUpperCase();
    if (!orgCodeKey) return;
    if (!assignmentsByOrgCode.has(orgCodeKey)) assignmentsByOrgCode.set(orgCodeKey, []);
    assignmentsByOrgCode.get(orgCodeKey).push(item);
  });

  assignmentsByOrgCode.forEach(orgAssignments => {
    if (orgAssignments.length < 2) return;

    const leaderAssignments = orgAssignments.filter(item => titleContainsLeaderKeyword_(item.title));
    if (leaderAssignments.length !== 1) return;

    const primaryKey = getAssignmentIdentityKey_(leaderAssignments[0]);
    orgAssignments.forEach(item => {
      const itemKey = getAssignmentIdentityKey_(item);
      leaderTypeMap.set(itemKey, itemKey === primaryKey ? '主職' : '垂直兼任');
    });
  });

  return leaderTypeMap;
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

function titleContainsLeaderKeyword_(title) {
  return String(title || '').trim().includes('長');
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
