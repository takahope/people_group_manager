/**
 * AuthService.gs — 身份驗證與權限管理服務
 * 職責：Google OAuth 身份識別、角色判斷、Session 管理
 * 
 * 設計原則：
 * - 以 Guard Clause 提早 return，避免深層巢狀
 * - Session 快取於 PropertiesService，TTL 8 小時
 */

// =============================================
// 角色定義常數
// =============================================

/** @const {Object} 系統角色代碼 */
const ROLES = {
  ADMIN:    'ROLE-APP-ADMIN',    // 系統管理員
  HR:       'ROLE-APP-HR',       // HR 人員
  MGR:      'ROLE-APP-MGR',      // 主管
  AUDITOR:  'ROLE-APP-AUDITOR',  // 稽核人員
  STAFF:    'ROLE-APP-STAFF',    // 一般員工
  EXTERNAL: 'ROLE-APP-EXTERNAL', // 外部人員
};

/** @const {number} Session 有效期（毫秒），8 小時 */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** @const {string} PropertiesService 的 Session Key 前綴 */
const SESSION_KEY_PREFIX = 'HR_SESSION_';

/** @const {string} Script Properties 中 admin 白名單 key */
const ADMIN_ROLE_EMAILS_KEY = 'ADMIN_ROLE_EMAILS';

/** @const {string} Script Properties 中 HR 白名單 key */
const HR_ROLE_EMAILS_KEY = 'HR_ROLE_EMAILS';

/** @const {string} Script Properties 中全站通行碼 key */
const SITE_PASSCODE_KEY = 'SITE_PASSCODE';

/** @const {number} 通行碼 Session 有效期（毫秒），8 小時 —— 與角色 Session TTL 分開定義，互不影響 */
const PASSCODE_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** @const {string} PropertiesService 的通行碼 Session Key 前綴 */
const PASSCODE_SESSION_KEY_PREFIX = 'HR_PASSCODE_SESSION_';

// =============================================
// Public API
// =============================================

/**
 * 取得目前登入者 Email 與角色代碼
 * 供前端初始化時呼叫
 * 
 * @returns {string} JSON — { success, data: { email, name, role, roleLabel } }
 */
function getCurrentUser() {
  try {
    const email = Session.getActiveUser().getEmail();
    if (!email) {
      Logger.log('getCurrentUser：Session.getActiveUser().getEmail() 為空值');
      return errorResponse(
        '無法取得登入 Email。請確認 Web App 以「使用者存取 Web 應用程式時」身分執行，且目前登入帳號與部署者位於允許的 Google Workspace 範圍內。'
      );
    }

    // 先嘗試從 Session 快取讀取
    const cached = getCachedSession(email);
    if (cached) return successResponse(cached);

    // Session 不存在或已過期，重新解析角色
    const userInfo = resolveUserRole(email);
    if (!userInfo) return errorResponse('您不在本系統的人員名單中');

    // 儲存至 Session
    saveSession(email, userInfo);
    return successResponse(userInfo);

  } catch (error) {
    Logger.log('getCurrentUser 錯誤：' + error.message);
    return errorResponse('身份驗證失敗：' + error.message);
  }
}

/**
 * 取得通行碼關卡狀態，供 doGet() 判斷要顯示哪一種頁面
 * 此為「進入系統前」的關卡，不涉及角色判斷
 *
 * @returns {string} JSON — { success, data: { configured, verified } }
 */
function getPasscodeGateStatus() {
  try {
    const configured = isPasscodeConfigured_();
    if (!configured) {
      return successResponse({ configured: false, verified: false });
    }

    const email = Session.getActiveUser().getEmail();
    if (!email) {
      Logger.log('getPasscodeGateStatus：Session.getActiveUser().getEmail() 為空值');
      return errorResponse(
        '無法取得登入 Email。請確認 Web App 以「使用者存取 Web 應用程式時」身分執行，且目前登入帳號與部署者位於允許的 Google Workspace 範圍內。'
      );
    }

    const verified = !!getCachedPasscodeSession_(email);
    return successResponse({ configured: true, verified });
  } catch (error) {
    Logger.log('getPasscodeGateStatus 錯誤：' + error.message);
    return errorResponse('通行碼狀態檢查失敗：' + error.message);
  }
}

/**
 * 驗證使用者輸入的通行碼，通過後寫入 8 小時效期的通行碼 Session
 * 不呼叫 checkPermission()：此為「進入系統前」關卡，尚無角色概念
 *
 * @param {string} code - 使用者輸入的通行碼
 * @returns {string} JSON — { success, data: { verified: true } } 或 { success:false, error }
 */
function verifyPasscode(code) {
  try {
    const email = Session.getActiveUser().getEmail();
    if (!email) {
      return errorResponse('無法取得登入 Email，請確認已使用組織 Google 帳號登入。');
    }

    const expected = getConfiguredPasscode_();
    if (!expected) {
      return errorResponse('系統尚未設定通行碼，請聯絡系統管理員設定。');
    }

    const submitted = String(code || '').trim();
    if (!submitted) {
      return errorResponse('請輸入通行碼');
    }
    if (submitted !== expected) {
      Logger.log(`verifyPasscode：通行碼錯誤，email=${email}`);
      return errorResponse('通行碼錯誤，請重新輸入');
    }

    savePasscodeSession_(email);
    return successResponse({ verified: true });
  } catch (error) {
    Logger.log('verifyPasscode 錯誤：' + error.message);
    return errorResponse('通行碼驗證失敗：' + error.message);
  }
}

/**
 * 驗證當前使用者是否有權限存取指定功能
 * 
 * 所有 API 函式在執行業務邏輯前應先呼叫此函式
 * @param {string} feature - 功能代碼（參見 PERMISSION_MAP）
 * @returns {boolean}
 */
function checkPermission(feature) {
  try {
    const email = Session.getActiveUser().getEmail();
    if (!email) {
      Logger.log(`checkPermission：無法取得登入 Email，feature=${feature}`);
      return false;
    }

    const cached = getCachedSession(email);
    const role = cached ? cached.role : resolveUserRole(email)?.role;
    if (!role) return false;

    return hasPermission(role, feature);
  } catch (error) {
    Logger.log('checkPermission 錯誤：' + error.message);
    return false;
  }
}

/**
 * 取得 Session 詳情
 * 
 * @returns {string} JSON — { success, data: { role, expiresAt } }
 */
function getSessionInfo() {
  try {
    const email = Session.getActiveUser().getEmail();
    if (!email) return errorResponse('未登入');

    const cached = getCachedSession(email);
    if (!cached) return errorResponse('Session 已過期，請重新整理頁面');

    return successResponse({
      role: cached.role,
      roleLabel: cached.roleLabel,
      expiresAt: cached.expiresAt,
    });
  } catch (error) {
    return errorResponse(error.message);
  }
}

/**
 * 清除目前登入者的 Session 快取，供前端強制重新驗證權限時使用
 *
 * @returns {string} JSON — { success, data: { cleared, email } }
 */
function clearCurrentUserSession() {
  try {
    const email = Session.getActiveUser().getEmail();
    if (!email) return errorResponse('未登入，無法清除 Session');

    const props = PropertiesService.getUserProperties();

    const key = SESSION_KEY_PREFIX + email;
    const existed = !!props.getProperty(key);
    props.deleteProperty(key);

    // 一併清除通行碼 Session，強制下次載入頁面時重新輸入通行碼
    const passcodeKey = PASSCODE_SESSION_KEY_PREFIX + email;
    const passcodeExisted = !!props.getProperty(passcodeKey);
    props.deleteProperty(passcodeKey);

    return successResponse({
      cleared: existed,
      clearedPasscode: passcodeExisted,
      email,
    });
  } catch (error) {
    Logger.log('clearCurrentUserSession 錯誤：' + error.message);
    return errorResponse('清除 Session 失敗：' + error.message);
  }
}

// =============================================
// 角色解析（Private）
// =============================================

/**
 * 根據 Email 與人員/職務資料解析使用者角色
 * 
 * 角色判斷順序（高→低）：ADMIN → HR → AUDITOR → MGR → EXTERNAL → STAFF
 * 提取此函式以降低 getCurrentUser 的認知複雜度
 * 
 * @param {string} email
 * @returns {Object|null} { email, name, role, roleLabel } 或 null
 */
function resolveUserRole(email) {
  if (!email) return null;

  // 查詢 Sheet 1 確認人員存在
  const personnel = DataService.findPersonByEmail(email);
  if (!personnel) return null;

  // 查詢 Sheet 3 取得職務配置（供非 admin 角色判斷使用）
  const assignments = DataService.findAssignmentsByEmail(email);

  // 依序判斷角色（Guard Clause 風格：高權限先判斷）
  const role = determineRole(email, personnel, assignments);

  return {
    email,
    name:      personnel.name,
    role,
    roleLabel: getRoleLabel(role),
  };
}

/**
 * 依優先順序判斷角色
 * 
 * 提取為獨立函式，讓每個判斷條件一目瞭然
 * @param {string} email
 * @param {Object} personnel
 * @param {Array}  assignments
 * @returns {string} 角色代碼
 */
function determineRole(email, personnel, assignments) {
  if (isAdminEmail(email))        return ROLES.ADMIN;
  if (isHR(email))                return ROLES.HR;
  if (isAuditor(assignments))     return ROLES.AUDITOR;
  if (isManager(email))           return ROLES.MGR;
  if (isExternal(email))          return ROLES.EXTERNAL;
  return ROLES.STAFF; // 預設角色
}

/** Email 命中 Script Properties 白名單 → 系統管理員 */
function isAdminEmail(email) {
  if (!email) return false;
  return getAdminRoleEmailSet_().has(normalizeEmail_(email));
}

function getAdminRoleEmailSet_() {
  const raw = PropertiesService.getScriptProperties()
    .getProperty(ADMIN_ROLE_EMAILS_KEY);

  if (!raw) return new Set();

  return new Set(
    String(raw)
      .split(',')
      .map(normalizeEmail_)
      .filter(Boolean)
  );
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

/** Email 命中 Script Properties HR 白名單 → HR 人員 */
function isHR(email) {
  if (!email) return false;
  return getHrRoleEmailSet_().has(normalizeEmail_(email));
}

function getHrRoleEmailSet_() {
  const raw = PropertiesService.getScriptProperties()
    .getProperty(HR_ROLE_EMAILS_KEY);

  if (!raw) return new Set();

  return new Set(
    String(raw)
      .split(',')
      .map(normalizeEmail_)
      .filter(Boolean)
  );
}

/** 所屬組別含 TF-GRP-AUDIT → 稽核人員 */
function isAuditor(assignments) {
  return assignments.some(a => a.orgCode.includes('TF-GRP-AUDIT'));
}

/** Sheet 3 中有其他員工以此人為直屬主管 → 主管 */
function isManager(email) {
  return DataService.hasDirectReport(email);
}

/** 信箱含 ext. 前綴或 PARTNER 組別 → 外部人員 */
function isExternal(email) {
  return email.startsWith('ext.') || email.includes('+ext@');
}

// =============================================
// 權限矩陣
// =============================================

/**
 * 功能權限對照 Map
 * key: feature 代碼，value: 允許的角色集合
 */
const PERMISSION_MAP = {
  'dashboard.full':        new Set([ROLES.ADMIN, ROLES.HR, ROLES.AUDITOR]),
  'dashboard.dept':        new Set([ROLES.MGR]),
  'dashboard.personal':    new Set([ROLES.STAFF]),
  'personnel.read.all':    new Set([ROLES.ADMIN, ROLES.HR, ROLES.AUDITOR]),
  'personnel.read.self':   new Set([ROLES.STAFF]),
  'personnel.read.dept':   new Set([ROLES.MGR]),
  'personnel.write':       new Set([ROLES.ADMIN, ROLES.HR]),
  'personnel.delete':      new Set([ROLES.ADMIN]),
  'personnel.import':      new Set([ROLES.ADMIN, ROLES.HR]),
  'personnel.export':      new Set([ROLES.ADMIN, ROLES.HR]),
  'org.read':              new Set([ROLES.ADMIN, ROLES.HR, ROLES.MGR, ROLES.AUDITOR, ROLES.STAFF]),
  'org.write':             new Set([ROLES.ADMIN, ROLES.HR]),
  'org.print':             new Set([ROLES.ADMIN, ROLES.HR]),
  'assignment.read.all':   new Set([ROLES.ADMIN, ROLES.HR, ROLES.AUDITOR]),
  'assignment.write':      new Set([ROLES.ADMIN, ROLES.HR]),
  'raci.read':             new Set([ROLES.ADMIN, ROLES.HR, ROLES.MGR, ROLES.AUDITOR, ROLES.STAFF, ROLES.EXTERNAL]),
  'rolemap.read':          new Set([ROLES.ADMIN, ROLES.HR, ROLES.AUDITOR]),
  'station.read':          new Set([ROLES.ADMIN, ROLES.HR, ROLES.MGR, ROLES.AUDITOR]),
  'station.write':         new Set([ROLES.ADMIN, ROLES.HR, ROLES.MGR, ROLES.AUDITOR]),
  'audit.run':             new Set([ROLES.ADMIN, ROLES.AUDITOR]),
  'audit.export':          new Set([ROLES.ADMIN, ROLES.AUDITOR]),
};

/**
 * 判斷角色是否有特定功能的權限
 * 
 * @param {string} role    - 角色代碼
 * @param {string} feature - 功能代碼
 * @returns {boolean}
 */
function hasPermission(role, feature) {
  const allowed = PERMISSION_MAP[feature];
  if (!allowed) return false;
  return allowed.has(role);
}

// =============================================
// Session 管理（Private）
// =============================================

/**
 * 從 PropertiesService 讀取快取的 Session
 * 若過期則返回 null（由呼叫者決定是否重新解析）
 * 
 * @param {string} email
 * @returns {Object|null}
 */
function getCachedSession(email) {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty(SESSION_KEY_PREFIX + email);
  if (!raw) return null;

  const session = JSON.parse(raw);
  if (Date.now() > session.expiresAt) {
    props.deleteProperty(SESSION_KEY_PREFIX + email);
    return null;
  }
  return session;
}

/**
 * 將 Session 資料存入 PropertiesService
 * 
 * @param {string} email
 * @param {Object} userInfo
 */
function saveSession(email, userInfo) {
  const session = {
    ...userInfo,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  PropertiesService.getUserProperties()
    .setProperty(SESSION_KEY_PREFIX + email, JSON.stringify(session));
}

// =============================================
// 通行碼關卡（Private）
// =============================================

/** Script Properties 是否已設定全站通行碼 */
function isPasscodeConfigured_() {
  return !!getConfiguredPasscode_();
}

/** 讀取 Script Properties 中設定的通行碼（已 trim，未設定回傳空字串） */
function getConfiguredPasscode_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SITE_PASSCODE_KEY);
  return raw ? String(raw).trim() : '';
}

/**
 * 從 PropertiesService 讀取快取的通行碼 Session
 * 若過期則返回 null（由呼叫者決定是否要求重新輸入）
 *
 * @param {string} email
 * @returns {Object|null}
 */
function getCachedPasscodeSession_(email) {
  const props = PropertiesService.getUserProperties();
  const raw = props.getProperty(PASSCODE_SESSION_KEY_PREFIX + email);
  if (!raw) return null;

  const session = JSON.parse(raw);
  if (Date.now() > session.expiresAt) {
    props.deleteProperty(PASSCODE_SESSION_KEY_PREFIX + email);
    return null;
  }
  return session;
}

/**
 * 將通行碼 Session 存入 PropertiesService（與角色 Session 完全分開存放）
 *
 * @param {string} email
 */
function savePasscodeSession_(email) {
  const session = {
    verifiedAt: Date.now(),
    expiresAt: Date.now() + PASSCODE_SESSION_TTL_MS,
  };
  PropertiesService.getUserProperties()
    .setProperty(PASSCODE_SESSION_KEY_PREFIX + email, JSON.stringify(session));
}

// =============================================
// 輔助：角色中文標籤
// =============================================

/** @const {Object} 角色代碼 → 中文顯示名稱 */
const ROLE_LABELS = {
  [ROLES.ADMIN]:    '系統管理員',
  [ROLES.HR]:       'HR 人員',
  [ROLES.MGR]:      '主管',
  [ROLES.AUDITOR]:  '稽核人員',
  [ROLES.STAFF]:    '一般員工',
  [ROLES.EXTERNAL]: '外部人員',
};

function getRoleLabel(role) {
  return ROLE_LABELS[role] || '未知角色';
}

/**
 * GAS 檔案層級函式預設會暴露為全域函式，不會自動形成命名空間物件。
 * 補上 AuthService namespace，讓其他檔案可用 AuthService.xxx 呼叫。
 */
const AuthService = {
  getCurrentUser,
  checkPermission,
  getSessionInfo,
  clearCurrentUserSession,
  resolveUserRole,
  determineRole,
  hasPermission,
  getRoleLabel,
  getPasscodeGateStatus,
};
