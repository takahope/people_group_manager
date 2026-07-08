/**
 * DashboardAPI.gs — 儀表板統計 API
 * 職責：彙整跨表統計資料，供儀表板頁面使用
 * 
 * 設計原則：
 * - 此模組只做「讀取與彙整」，不寫入任何資料
 * - 每個統計函式獨立，儀表板可依角色選擇組合呼叫
 */

// =============================================
// 儀表板完整統計（一次呼叫取得所有卡片資料）
// =============================================

/**
 * 取得儀表板所需的完整統計資料
 * 依角色回傳不同範圍的統計（避免多次往返 API）
 *
 * @param {{view?:string}} options
 *   view：主管（dashboard.dept）可傳 'company' 切換為全公司視角；其餘角色忽略此參數。
 * @returns {string} JSON 回應
 */
function getDashboardStats(options) {
  try {
    const email = Session.getActiveUser().getEmail();
    const view = String((options && options.view) || '').trim();

    // 依角色決定統計範圍
    if (checkPermission('dashboard.full')) {
      return successResponse(buildFullStats());
    }
    if (checkPermission('dashboard.dept')) {
      if (view === 'company') {
        return successResponse(buildMgrCompanyStats_());
      }
      return successResponse(buildDeptStats(email));
    }
    if (checkPermission('dashboard.personal')) {
      return successResponse(buildPersonalStats(email));
    }
    return errorResponse('無查詢儀表板的權限');
  } catch (error) {
    Logger.log('getDashboardStats 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

/**
 * 取得應用程式診斷資訊，供前端錯誤頁與 console 對照使用。
 *
 * 僅限可檢視完整儀表板的角色呼叫，避免暴露過多內部資訊。
 * @returns {string} JSON 回應
 */
function getAppDebugInfo() {
  try {
    if (!checkPermission('dashboard.full')) {
      return errorResponse('無查詢診斷資訊的權限');
    }

    const email = Session.getActiveUser().getEmail();
    const userInfo = resolveUserRole(email);
    const ss = getSpreadsheet();
    const sheetStatus = buildSheetStatus_();

    return successResponse({
      user: userInfo ? {
        email: userInfo.email,
        role: userInfo.role,
        roleLabel: userInfo.roleLabel,
      } : { email },
      spreadsheet: {
        id: ss.getId(),
        name: ss.getName(),
        url: ss.getUrl(),
      },
      counts: {
        personnel: DataService.getSheet1Data().length,
        org: DataService.getSheet2Data(null).length,
        assignment: DataService.getAllAssignments().length,
        raci: DataService.getSheet4Data(null).length,
        roleMap: DataService.getSheet5Data().length,
      },
      sheets: sheetStatus,
    });
  } catch (error) {
    Logger.log('getAppDebugInfo 錯誤：' + (error.stack || error.message));
    return errorResponse(error.message);
  }
}

// =============================================
// 各範圍統計建構函式（Private）
// =============================================

/**
 * 完整統計（ADMIN / HR / AUDITOR 可見）
 * 
 * @returns {Object}
 */
function buildFullStats() {
  const personnel  = DataService.getSheet1Data();
  const orgData    = DataService.getSheet2Data(null);
  const orgGraph   = analyzeOrgGraph(orgData);
  const representativeEmails = buildRepresentativeEmailSet_();
  const activeEmails = new Set(
    personnel.filter(p => p.status === '在勤').map(p => p.email)
  );
  const assignments = DataService.getAllAssignments()
    .filter(a => activeEmails.has(a.email));
  const raciData   = DataService.getSheet4Data(null);

  return {
    scope: 'full',
    warnings: orgGraph.warnings,
    personnel: buildPersonnelStats(personnel, assignments, representativeEmails),
    orgDistribution: buildOrgDistribution(orgData, assignments, orgGraph.descendantsByCode),
    concurrentPersonnel: buildConcurrentList(assignments),
    raciCoverage: buildRaciCoverage(raciData),
    auditAlerts: buildQuickAuditAlerts(),
    recentLogs: DataService.getRecentAuditLogs(10),
  };
}

/**
 * 依指定人員範圍組出主管視角共用的統計回應。
 *
 * @param {string} scope 'dept' | 'company'
 * @param {Array<Object>} personnelList 範圍內的人員主檔列
 * @param {Array<Object>} scopedAssignments 範圍內的職務配置列
 * @param {Set<string>} representativeEmails
 * @returns {Object}
 */
function buildScopedStats_(scope, personnelList, scopedAssignments, representativeEmails) {
  const activeList = personnelList.filter(p => p.status === '在勤');
  const payrollList = personnelList.filter(p => isActualPayrollPersonnel_(p, representativeEmails));
  const repCounts = buildRepresentativeAwareCounts_(personnelList, representativeEmails);

  return {
    scope,
    warnings: [],
    personnel: {
      total: activeList.length,
      totalAll: personnelList.length,
      activeTotal: activeList.length,
      actualPayrollTotal: payrollList.length,
      activeIncludeRep: repCounts.activeIncludeRep,
      activeExcludeRep: repCounts.activeExcludeRep,
      payrollIncludeRep: repCounts.payrollIncludeRep,
      payrollExcludeRep: repCounts.payrollExcludeRep,
      statusBreakdown: buildStatusBreakdown_(personnelList),
    },
    concurrentPersonnel: buildConcurrentList(scopedAssignments),
    recentLogs: DataService.getRecentAuditLogs(5),
  };
}

/**
 * 部門統計（主管可見轄下成員）
 *
 * @param {string} managerEmail
 * @returns {Object}
 */
function buildDeptStats(managerEmail) {
  const all = DataService.getAllAssignments();
  const representativeEmails = buildRepresentativeEmailSet_(all);
  const deptEmails = new Set(
    all.filter(a => a.managerEmail === managerEmail).map(a => a.email)
  );

  const deptPersonnel = DataService.getSheet1Data()
    .filter(p => deptEmails.has(p.email));

  return buildScopedStats_(
    'dept',
    deptPersonnel,
    all.filter(a => deptEmails.has(a.email)),
    representativeEmails
  );
}

/**
 * 全公司統計（主管切換視角用），資料範圍與人員管理頁的主管視角一致：
 * 在職子狀態（ACTIVE_PERSONNEL_STATUSES）＋今年離職者。
 *
 * @returns {Object}
 */
function buildMgrCompanyStats_() {
  const all = DataService.getAllAssignments();
  const representativeEmails = buildRepresentativeEmailSet_(all);
  const companyPersonnel = DataService.getSheet1Data().filter(p => {
    if (p.status === '離職') return isLeaveDateThisYear_(p.leaveDate);
    return ACTIVE_PERSONNEL_STATUSES.indexOf(p.status) >= 0;
  });
  const emailSet = new Set(
    companyPersonnel.map(p => String(p.email || '').trim().toLowerCase()).filter(Boolean)
  );

  return buildScopedStats_(
    'company',
    companyPersonnel,
    all.filter(a => emailSet.has(String(a.email || '').trim().toLowerCase())),
    representativeEmails
  );
}

/**
 * 個人統計（一般員工僅能看自身）
 * 
 * @param {string} email
 * @returns {Object}
 */
function buildPersonalStats(email) {
  const person = DataService.findPersonByEmail(email);
  const assignments = DataService.getSheet3DataByEmail(email);
  const representativeEmails = buildRepresentativeEmailSet_();
  const actualPayroll = person && isActualPayrollPersonnel_(person, representativeEmails) ? 1 : 0;

  return {
    scope: 'personal',
    warnings: [],
    person,
    assignments,
    actualPayroll,
    assignmentCount: assignments.length,
    status: person ? person.status : '',
    concurrentCount: assignments.length > 1 ? assignments.length : 0,
  };
}

// =============================================
// 統計子函式
// =============================================

/**
 * 人員統計卡資料
 * 分類：行政組織人員 / 任務編組人員 / 外部人員 / 總人數
 * 
 * @param {Array} personnel
 * @param {Array} assignments
 * @returns {Object}
 */
function buildPersonnelStats(personnel, assignments, representativeEmails) {
  const activePersonnel = personnel.filter(p => p.status === '在勤');
  const actualPayrollPersonnel = personnel.filter(p => isActualPayrollPersonnel_(p, representativeEmails));
  const repCounts = buildRepresentativeAwareCounts_(personnel, representativeEmails);

  // 以職務配置判斷人員所屬類型
  const orgCodes = new Set(DataService.getSheet2Data('ORG').map(o => o.code));
  const tfCodes  = new Set(DataService.getSheet2Data('TF').map(o => o.code));
  const activeEmails = new Set(activePersonnel.map(p => p.email));

  const inOrg      = new Set();
  const inTF       = new Set();
  const inExternal = new Set();

  assignments.forEach(a => {
    if (!activeEmails.has(a.email)) return;
    if (orgCodes.has(a.orgCode))       inOrg.add(a.email);
    else if (tfCodes.has(a.orgCode))   inTF.add(a.email);
    else                               inExternal.add(a.email);
  });

  return {
    total:    activePersonnel.length,
    totalAll: personnel.length,
    activeTotal: activePersonnel.length,
    actualPayrollTotal: actualPayrollPersonnel.length,
    activeIncludeRep: repCounts.activeIncludeRep,
    activeExcludeRep: repCounts.activeExcludeRep,
    payrollIncludeRep: repCounts.payrollIncludeRep,
    payrollExcludeRep: repCounts.payrollExcludeRep,
    statusBreakdown: buildStatusBreakdown_(personnel),
    orgCount: inOrg.size,
    tfCount:  inTF.size,
    extCount: inExternal.size,
  };
}

/**
 * 計算「在勤／在職」兩個口徑各自「含代表人」與「不含代表人」的人數，
 * 供儀表板前端切換顯示（比照人員管理頁的代表人切換）。
 *
 * @param {Array<Object>} personnel 範圍內人員主檔列
 * @param {Set<string>} representativeEmails 代表人信箱集合（小寫）
 * @returns {{activeIncludeRep:number, activeExcludeRep:number, payrollIncludeRep:number, payrollExcludeRep:number}}
 */
function buildRepresentativeAwareCounts_(personnel, representativeEmails) {
  const isRep = (p) => {
    const email = String(p?.email || '').trim().toLowerCase();
    return !!(representativeEmails && email && representativeEmails.has(email));
  };
  const activeAll = (personnel || []).filter(p => p.status === '在勤');
  // 僅以狀態排除（保留代表人），代表人是否計入交由前端切換
  const payrollAll = (personnel || []).filter(p => isActualPayrollPersonnel_(p, null));
  return {
    activeIncludeRep: activeAll.length,
    activeExcludeRep: activeAll.filter(p => !isRep(p)).length,
    payrollIncludeRep: payrollAll.length,
    payrollExcludeRep: payrollAll.filter(p => !isRep(p)).length,
  };
}

function buildStatusBreakdown_(personnel) {
  const breakdown = {
    在勤: 0,
    育嬰假: 0,
    休假: 0,
    合作單位: 0,
    委外廠商: 0,
    倫理委員會: 0,
    離職: 0,
  };

  (personnel || []).forEach(person => {
    if (Object.prototype.hasOwnProperty.call(breakdown, person.status)) {
      breakdown[person.status] += 1;
    }
  });

  return breakdown;
}

function isActualPayrollPersonnel_(person, representativeEmails) {
  const excludedStatuses = new Set(['倫理委員會', '合作單位', '委外廠商', '離職']);
  if (!person) return false;
  const normalizedEmail = String(person.email || '').trim().toLowerCase();
  return !excludedStatuses.has(String(person.status || '').trim())
    && !(representativeEmails && representativeEmails.has(normalizedEmail));
}

function buildRepresentativeEmailSet_(assignments) {
  const representativeEmails = new Set();
  (assignments || DataService.getAllAssignments()).forEach(item => {
    if (String(item?.title || '').trim() !== '代表人') return;
    const email = String(item?.email || '').trim().toLowerCase();
    if (email) representativeEmails.add(email);
  });
  return representativeEmails;
}

/**
 * 各部門人數分佈（用於長條圖）
 * 依 Sheet 2 層級 3 分組
 * 
 * @param {Array} orgData
 * @param {Array} assignments
 * @param {Map<string, Set<string>>} descendantsByCode
 * @returns {Array<{deptName, count}>}
 */
function buildOrgDistribution(orgData, assignments, descendantsByCode) {
  const level3Orgs = orgData.filter(o => o.level === 3);

  return level3Orgs.map(dept => {
    const subtreeCodes = descendantsByCode.get(dept.code) || new Set([dept.code]);
    const count = new Set(
      assignments.filter(a => subtreeCodes.has(a.orgCode)).map(a => a.email)
    ).size;
    return { deptCode: dept.code, deptName: dept.name, count };
  }).filter(d => d.count > 0);
}

/**
 * 兼任人員一覽
 * Sheet 3 中擁有多筆記錄的人員
 * 
 * @param {Array} assignments
 * @returns {Array<{email, name, count, types}>}
 */
function buildConcurrentList(assignments) {
  const emailMap = new Map();
  assignments.forEach(a => {
    if (!emailMap.has(a.email)) emailMap.set(a.email, []);
    emailMap.get(a.email).push(a);
  });

  const concurrent = [];
  emailMap.forEach((list, email) => {
    if (list.length <= 1) return;
    concurrent.push({
      email,
      name:  list[0].name,
      count: list.length,
      orgs:  list.map(a => a.orgName),
    });
  });
  return concurrent;
}

/**
 * RACI 任務覆蓋率
 * 已定義 RACI 的工作項目數 vs. 文件總數
 * 
 * @param {Array} raciData
 * @returns {Object}
 */
function buildRaciCoverage(raciData) {
  const total = raciData.length;
  // 有完整 R、A 欄位的視為已覆蓋
  const covered = raciData.filter(item => item.R && item.A).length;
  return {
    total,
    covered,
    rate: total > 0 ? Math.round((covered / total) * 100) : 0,
  };
}

/**
 * 快速稽核警示（儀表板用，不執行完整稽核）
 * 只計算 A 欄唯一性與角色代碼存在性的異常數
 * 
 * @returns {Object}
 */
function buildQuickAuditAlerts() {
  try {
    // 複用 AuditAPI 的私有邏輯（直接呼叫，不走 public API 的權限檢查）
    const aIssues    = JSON.parse(checkAccountabilityUniqueness());
    const roleIssues = JSON.parse(checkRoleCodeExists());

    const aCount    = aIssues.success ? aIssues.data.length : -1;
    const roleCount = roleIssues.success ? roleIssues.data.length : -1;

    return {
      accountabilityIssues: aCount,
      roleCodeIssues:       roleCount,
      hasAlert:             aCount > 0 || roleCount > 0,
    };
  } catch (e) {
    return { accountabilityIssues: -1, roleCodeIssues: -1, hasAlert: false };
  }
}

function buildSheetStatus_() {
  return Object.values(SHEET_NAMES).map(name => {
    try {
      const sheet = getSheet(name);
      return {
        name,
        exists: true,
        lastRow: sheet.getLastRow(),
        lastColumn: sheet.getLastColumn(),
      };
    } catch (error) {
      return {
        name,
        exists: false,
        error: error.message,
      };
    }
  });
}
