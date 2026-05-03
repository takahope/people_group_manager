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
 * @returns {string} JSON 回應
 */
function getDashboardStats() {
  try {
    const email = Session.getActiveUser().getEmail();

    // 依角色決定統計範圍
    if (checkPermission('dashboard.full')) {
      return successResponse(buildFullStats());
    }
    if (checkPermission('dashboard.dept')) {
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
  const activeEmails = new Set(
    personnel.filter(p => p.status === '在職').map(p => p.email)
  );
  const assignments = DataService.getAllAssignments()
    .filter(a => activeEmails.has(a.email));
  const raciData   = DataService.getSheet4Data(null);

  return {
    scope: 'full',
    warnings: orgGraph.warnings,
    personnel: buildPersonnelStats(personnel, assignments),
    orgDistribution: buildOrgDistribution(orgData, assignments, orgGraph.descendantsByCode),
    concurrentPersonnel: buildConcurrentList(assignments),
    raciCoverage: buildRaciCoverage(raciData),
    auditAlerts: buildQuickAuditAlerts(),
    recentLogs: DataService.getRecentAuditLogs(10),
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
  const deptEmails = new Set(
    all.filter(a => a.managerEmail === managerEmail).map(a => a.email)
  );

  const deptPersonnel = DataService.getSheet1Data()
    .filter(p => deptEmails.has(p.email));
  const activeDeptPersonnel = deptPersonnel.filter(p => p.status === '在職');

  return {
    scope: 'dept',
    warnings: [],
    personnel: {
      total: activeDeptPersonnel.length,
      totalAll: deptPersonnel.length,
      activeTotal: activeDeptPersonnel.length,
      details: deptPersonnel,
    },
    concurrentPersonnel: buildConcurrentList(
      all.filter(a => deptEmails.has(a.email))
    ),
    recentLogs: DataService.getRecentAuditLogs(5),
  };
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

  return {
    scope: 'personal',
    warnings: [],
    person,
    assignments,
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
function buildPersonnelStats(personnel, assignments) {
  const activePersonnel = personnel.filter(p => p.status === '在職');

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

  const statusBreakdown = {
    在職: 0,
    育嬰: 0,
    休假: 0,
    留職停薪: 0,
  };
  personnel.forEach(person => {
    if (Object.prototype.hasOwnProperty.call(statusBreakdown, person.status)) {
      statusBreakdown[person.status] += 1;
    }
  });

  return {
    total:    activePersonnel.length,
    totalAll: personnel.length,
    activeTotal: activePersonnel.length,
    statusBreakdown,
    orgCount: inOrg.size,
    tfCount:  inTF.size,
    extCount: inExternal.size,
  };
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
